require("dotenv").config();
const path = require("path");
const express = require("express");
const { MessagingResponse } = require("twilio").twiml;
const twilio = require("twilio");
const OpenAI = require("openai");
const db = require("./database");
const auth = require("./auth");
const assignments = require("./assignments");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS Middleware - MUST be first
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── FETCH LIVE DATA FROM DATABASE ────────────────────────────────────
async function getLiveContext() {
  try {
    const [projectsRes, ratesRes, companyRes] = await Promise.all([
      db.supabase.from('projects').select('*'),
      db.supabase.from('plot_rates_v2').select('*').limit(100),
      db.supabase.from('company_profile').select('*').single()
    ]);

    const projects = projectsRes.data || [];
    const rates = ratesRes.data || [];
    const company = companyRes.data || null;

    console.log("🔍 Fetched", projects.length, "projects,", rates.length, "plot rates");

    let context = `\n\n=== LIVE COMPANY DATA (Updated) ===\n`;

    // Company Profile
    if (company) {
      context += `\nCOMPANY: ${company.name}\n`;
      context += `About: ${company.about}\n`;
      context += `Website: ${company.website}\n`;
      context += `Phone: ${company.phone}\n`;
      context += `Email: ${company.email}\n`;
      context += `Address: ${company.address}\n`;
    }

    // Projects
    if (projects.length > 0) {
      context += `\n--- ACTIVE PROJECTS ---\n`;
      projects.forEach(p => {
        context += `\n📍 ${p.name}\n`;
        context += `Location: ${p.location}\n`;
        context += `Description: ${p.description}\n`;
        context += `Type: ${p.type}\n`;
        context += `Price Range: ${p.price_min}L - ${p.price_max}L\n`;
        context += `Features: ${p.features}\n`;
        context += `Inventory: ${p.inventory_status}\n`;
      });
    }

    // Plot Rates
    if (rates.length > 0) {
      context += `\n--- CURRENT PLOT RATES ---\n`;
      const ratesByType = {};
      rates.forEach(r => {
        const key = `${r.sector}-${r.size}`;
        if (!ratesByType[key]) {
          ratesByType[key] = [];
        }
        ratesByType[key].push(`Plot ${r.plot_no_from}-${r.plot_no_to}: Rs ${r.min_price/100000}L - ${r.max_price/100000}L`);
      });
      
      Object.entries(ratesByType).forEach(([key, values]) => {
        context += `\n${key}:\n`;
        values.forEach(v => context += `  ${v}\n`);
      });
    }

    return context;
  } catch (err) {
    console.error("❌ Context error:", err.message);
    return '';
  }
}

// ─── BUILD INTELLIGENT SYSTEM PROMPT ──────────────────────────────────
async function buildSystemPrompt(client = {}) {
  const liveContext = await getLiveContext();
  console.log("📊 Live context length:", liveContext.length);
  console.log("📊 Context preview:", liveContext.substring(0, 200));

  // Tell the AI the current handoff state so it behaves naturally.
  let handoffNote = "";
  if (client.escalated) {
    handoffNote = `

⚠️ HANDOFF STATUS: This client has ALREADY been handed off to the human sales team.
- Keep helping them naturally: answer any questions about projects, plots, rates, locations, investment.
- A human agent will contact them separately — you may gently reassure them of this if relevant, but do NOT make them feel ignored or stuck.
- Do NOT write [ESCALATE] again for the same buying intent. Only write [ESCALATE] if the client raises a clearly NEW request that needs a human (e.g. a different property/deal, a scheduling change, or an explicit "transfer me again").
- Never repeat a robotic "team will contact you" line on every message. Continue the conversation like a knowledgeable assistant.`;
  }

  return `You are an intelligent, friendly sales assistant for Bodla Group — a leading real estate company in DHA Multan, Pakistan.

YOUR CORE ROLE:
- Understand what the client wants naturally (no keyword matching)
- Answer questions about projects, plots, rates, locations, investment
- Engage in natural conversation
- Provide accurate information from company database

YOUR BEHAVIOR:

🎯 INFORMATION STAGE:
Answer ALL questions about:
- Project details, features, amenities, locations
- Plot sizes, prices, payment plans
- Investment potential, market insights
- Company background, credentials
- Location benefits, nearby facilities

Provide detailed, helpful answers. Ask follow-up questions to understand their needs better.

⚡ ESCALATION STAGE:
ONLY escalate to human agent when client clearly expresses:
1. Intent to purchase/book: "book karna hai", "lena hai", "buy", "purchase", "finalize deal"
2. Request for meeting/visit: "visit karna chahta hoon", "office aana chahta hoon", "agent se milna hai"
3. Specific transaction help: "payment kaise hoti hai", "possession kab milega", "contract kaise banegi"
4. After answering multiple detailed questions and client shows serious buying intent

DO NOT escalate for:
- General project information questions
- Price/rate inquiries
- Location/amenity questions
- Investment advice
- Company questions
- "Tell me more" requests

When escalating, respond warmly: "Zaroor! Hamara sales team aap se jald contact karega. Jazakallah! 🙏"
Then on a NEW LINE write exactly ONE of these tags depending on the client's interest:
- [ESCALATE:PLOT] — for plot buying/selling, plot rates, plot files, sectors, plot investment (Plot Trading team)
- [ESCALATE:PROJECT] — for projects, apartments, shops, bookings, installment plans (Project Sales team)
If unsure, use [ESCALATE:PLOT].

YOUR STYLE:
- Warm, professional, conversational
- Adapt to client's language (formal/casual/Urdu mix)
- Use real estate terminology naturally
- Keep WhatsApp replies concise (3-5 lines)
- Be honest about data ("I'll check that for you")

${liveContext}
${handoffNote}

Remember: You have LIVE company data above. Use it to answer accurately. If client asks about something not in the data, acknowledge it professionally.`;
}

// ─── CHECK IF SHOULD ESCALATE (+ which department) ────────────────────
// Returns null if no escalation, else 'PLOT' or 'PROJECT'.
function getEscalation(aiReply) {
  const m = aiReply.match(/\[ESCALATE(?::(PLOT|PROJECT))?\]/i);
  if (!m) return null;
  if (m[1]) return m[1].toUpperCase();
  // Plain [ESCALATE] with no dept → infer from content, default PLOT.
  const text = aiReply.toLowerCase();
  if (text.includes("project") || text.includes("apartment") || text.includes("booking") || text.includes("installment")) {
    return "PROJECT";
  }
  return "PLOT";
}

function shouldEscalate(aiReply) {
  return getEscalation(aiReply) !== null;
}

function cleanReply(text) {
  return text.replace(/\[ESCALATE(?::(?:PLOT|PROJECT))?\]/gi, "").trim();
}

// ─── SEND MESSAGE TO SALES AGENT ─────────────────────────────────────
async function notifyAgent(clientPhone, clientName, chatHistory) {
  const agentPhone = process.env.SALES_AGENT_WHATSAPP;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

  const header =
    `🔔 *New Lead — Bodla Bot*\n` +
    `*Client:* ${clientName || "Unknown"}\n` +
    `*Phone:* ${clientPhone}\n` +
    `*Follow-up needed*`;

  await twilioClient.messages.create({
    from,
    to: `whatsapp:${agentPhone}`,
    body: header,
  });

  const lines = chatHistory.map(
    (m) => `${m.role === "user" ? clientName || "Client" : "Bot"}: ${m.content}`
  );

  const LIMIT = 1400;
  let chunk = "*Chat Log:*\n";
  let chunkNum = 1;

  for (const line of lines) {
    if ((chunk + "\n" + line).length > LIMIT) {
      await twilioClient.messages.create({
        from,
        to: `whatsapp:${agentPhone}`,
        body: chunk,
      });
      chunkNum++;
      chunk = `*Chat Log (cont.):*\n${line}`;
    } else {
      chunk += "\n" + line;
    }
  }

  if (chunk.trim()) {
    await twilioClient.messages.create({
      from,
      to: `whatsapp:${agentPhone}`,
      body: chunk,
    });
  }
}

// ─── MAIN WEBHOOK ────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
console.log("🔔 WEBHOOK RECEIVED:", req.body.From, req.body.Body);

  const incomingMsg = req.body.Body?.trim();
  const clientPhone = req.body.From?.replace("whatsapp:", "");
  const profileName = req.body.ProfileName || null;

  if (!incomingMsg || !clientPhone) {
    return res.status(400).send("Bad request");
  }

  const twiml = new MessagingResponse();

  try {
    // 1. Get or create client
    let client = await db.getClient(clientPhone);
    if (!client) {
      client = await db.createClient(clientPhone, profileName);
    } else if (!client.name && profileName) {
      await db.updateClientName(clientPhone, profileName);
      client.name = profileName;
    }

    // 2. Save incoming message
    await db.saveMessage(clientPhone, "user", incomingMsg);

    // NOTE: We intentionally do NOT short-circuit escalated clients with a
    // canned holding reply. This is an AI chatbot — it should keep answering
    // naturally even after handoff. The system prompt is told about the
    // handoff state so it won't re-escalate the same intent.

    // 4. Load chat history
    const history = await db.getChatHistory(clientPhone);

    // 5. Build messages for OpenAI (system prompt is handoff-aware)
    const messages = [
      { role: "system", content: await buildSystemPrompt(client) },
      ...history.map((m) => ({ 
        role: m.role === "agent" ? "assistant" : m.role, 
        content: m.content
      })),
    ];

    console.log("🤖 OpenAI call:", messages.length, "messages, phone:", clientPhone);

    // 6. Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const rawReply = completion.choices[0].message.content;
    const department = getEscalation(rawReply); // null | 'PLOT' | 'PROJECT'
    const escalate = department !== null;
    const botReply = cleanReply(rawReply);

    // 7. Save bot reply
    await db.saveMessage(clientPhone, "assistant", botReply);

    // 8. On a fresh escalation, route to the right team + auto-assign an agent
    if (escalate && !client.escalated) {
      try {
        const result = await assignments.autoAssignOnEscalation(
          clientPhone,
          client.name,
          department
        );
        if (result.assigned) {
          console.log(`✅ Auto-assigned ${clientPhone} → ${result.agent.full_name} (${department})`);
        } else if (result.alreadyAssigned) {
          console.log(`ℹ️ ${clientPhone} already locked to an agent; stamps updated`);
        } else {
          console.log(`⚠️ No free agent in ${department} team — ${clientPhone} left in pool`);
          // Fall back to the old single-number notify so a human still sees it
          try {
            const fullHistory = await db.getChatHistory(clientPhone);
            await notifyAgent(clientPhone, client.name, fullHistory);
          } catch (e) { console.error("Fallback notify failed:", e.message); }
        }
      } catch (assignErr) {
        console.error("Auto-assign failed:", assignErr.message);
        // Ensure the lead is at least marked escalated so it isn't lost
        await db.markEscalated(clientPhone, true);
      }
    } else if (escalate && client.escalated) {
      console.log("ℹ️ Already escalated — AI handled NEW intent, not re-routed:", clientPhone);
    }

    // 9. Reply to client
    twiml.message(botReply);
    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("Sorry, kuch technical issue aa gaya. Thoda baad mein try karein. Jazakallah!");
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// ─── DASHBOARD (React SPA is served as static files at the bottom) ─────

app.get("/api/clients", auth.requireAuth(["admin", "manager", "agent"]), async (req, res) => {
  try {
    const clients = await db.getAllClients(req.user);
    const data = await Promise.all(
      clients.map(async (c) => ({
        ...c,
        messages: await db.getChatHistory(c.phone),
      }))
    );
    res.json(data);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json([]);
  }
});

app.get("/health", (req, res) => res.send("Bodla Bot running."));

// ─── DROP C: SLA CRON ENDPOINT ────────────────────────────────────────
// Hit this every minute from an external scheduler (e.g. cron-job.org).
// Protected by a secret token so randoms can't trigger it.
app.all("/cron/check-sla", async (req, res) => {
  const token = req.query.token || req.headers["x-cron-token"];
  if (token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await assignments.checkSLA();
    console.log("⏱️ SLA scan:", JSON.stringify(result));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("SLA scan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Mark a client's chat as seen (stops the SLA clock). Called when an agent opens the chat.
app.post("/api/leads/:phone/seen", auth.requireAuth(["admin", "manager", "agent"]), async (req, res) => {
  try {
    await assignments.markClientSeen(req.params.phone);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── AUTH & ADMIN ─────────────────────────────────────────────────────

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const result = await auth.login(username, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/me", auth.requireAuth(), (req, res) => {
  res.json(req.user);
});

app.get("/api/users", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { role, team_id } = req.query;
    const users = await auth.getUsers(role || null, team_id || null);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { username, password, full_name, role, team_id } = req.body;
    const user = await auth.createUser(username, password, full_name, role, team_id || null);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/users/:id", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const user = await auth.updateUser(req.params.id, req.body);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/users/:id", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }
    const result = await auth.deleteUser(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/teams", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const teams = await auth.getTeams();
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/teams", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { name, manager_id } = req.body;
    const team = await auth.createTeam(name, manager_id || null);
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/teams/:id", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const team = await auth.updateTeam(req.params.id, req.body);
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/teams/:id", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const result = await auth.deleteTeam(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/leads", auth.requireAuth(["admin", "manager", "agent"]), async (req, res) => {
  try {
    const leads = await assignments.getLeads(req.user);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leads/assign", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { client_phone, agent_id } = req.body;
    const result = await assignments.assignClient(client_phone, agent_id, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/leads/transfer", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { client_phone, to_agent_id, reason } = req.body;
    const result = await assignments.transferClient(client_phone, to_agent_id, req.user.id, reason || null);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/agent/reply", auth.requireAuth(["admin", "manager", "agent"]), async (req, res) => {
  try {
    const { client_phone, message } = req.body;
    if (!client_phone || !message) return res.status(400).json({ error: "client_phone and message required" });

    const phone = client_phone.startsWith("+") ? client_phone : `+${client_phone}`;

    console.log(`Agent reply: sending to whatsapp:${phone} from whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`);

    const result = await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phone}`,
      body: message,
    });

    await db.saveMessage(phone, "agent", message, {
      id: req.user.id,
      full_name: req.user.full_name,
      role: req.user.role,
    });
    // Replying counts as seeing — stop the SLA clock.
    await assignments.markClientSeen(phone);
    res.json({ success: true, sid: result.sid });
  } catch (err) {
    console.error("Agent reply error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/plot-rates-v2", auth.requireAuth(), async (req, res) => {
  try {
    let query = db.supabase.from("plot_rates_v2").select("*").order("sector").order("plot_no_from");
    if (req.query.sector) query = query.eq("sector", req.query.sector);
    if (req.query.type) query = query.eq("plot_type", req.query.type);
    const { data } = await query;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/plot-rates-v2", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { id, sector, plot_type, size, plot_no_from, plot_no_to, min_price, max_price, features, notes } = req.body;
    const payload = { sector, plot_type, size, plot_no_from, plot_no_to, min_price, max_price, features: features||{}, notes, updated_by: req.user.id, updated_at: new Date().toISOString() };

    let result;
    if (id) {
      // Edit existing row
      result = await db.supabase.from("plot_rates_v2").update(payload).eq("id", id).select().single();
    } else {
      // New row
      result = await db.supabase.from("plot_rates_v2").insert(payload).select().single();
    }
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/plot-rates-v2/:id", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { error } = await db.supabase.from("plot_rates_v2").delete().eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── PROJECTS (NEW) ───────────────────────────────────────────────────
app.get("/api/projects", auth.requireAuth(), async (req, res) => {
  try {
    const { data } = await db.supabase.from("projects").select("*").order("created_at", { ascending: false });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { name, location, description, type, price_min, price_max, features, inventory_status } = req.body;
    const { data, error } = await db.supabase
      .from("projects")
      .insert({ name, location, description, type, price_min, price_max, features, inventory_status })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── COMPANY PROFILE (NEW) ────────────────────────────────────────────
app.get("/api/company-profile", auth.requireAuth(), async (req, res) => {
  try {
    const { data } = await db.supabase.from("company_profile").select("*").single();
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/company-profile", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { name, about, website, phone, email, address } = req.body;
    const { data, error } = await db.supabase
      .from("company_profile")
      .upsert({ name, about, website, phone, email, address }, { onConflict: "id" })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── SERVE REACT ADMIN/AGENT PANEL (built by `vite build` → dist/) ─────
const DIST_DIR = path.join(__dirname, "dist");
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback: any non-API, non-webhook GET returns index.html
  app.get(/^\/(?!api|webhook|health).*/, (req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
  console.log("🖥️  Serving React panel from /dist");
} else {
  console.log("⚠️  No /dist folder — run `npm run build` before deploy to serve the panel");
}

// ─── START SERVER ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bodla Bot running on port ${PORT}`));