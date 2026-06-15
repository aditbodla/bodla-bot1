const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
const ws = require("ws");
const twilio = require("twilio");

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: ws } }
);

// ─── Get leads (with role-based filtering) ────────────────────────────────────
async function getLeads(user) {
  let query = supabase
    .from("clients")
    .select(`
      id, phone, name, escalated, agent_requested, is_locked,
      created_at, last_seen, team_id,
      assigned_agent:assigned_to(id, full_name, username),
      team:team_id(id, name)
    `)
    .eq("escalated", true)
    .order("last_seen", { ascending: false });

  // Manager sees only their team
  if (user.role === "manager") {
    query = query.eq("team_id", user.team_id);
  }

  // Agent sees only their own
  if (user.role === "agent") {
    query = query.eq("assigned_to", user.id);
  }

  const { data } = await query;
  return data || [];
}

// ─── Assign client to agent ───────────────────────────────────────────────────
async function assignClient(clientPhone, agentId, assignedBy) {
  // Get agent info
  const { data: agent } = await supabase
    .from("users")
    .select("id, full_name, team_id")
    .eq("id", agentId)
    .single();

  if (!agent) throw new Error("Agent not found");

  // Check if already locked to another agent
  const { data: client } = await supabase
    .from("clients")
    .select("assigned_to, is_locked, name")
    .eq("phone", clientPhone)
    .single();

  if (client?.is_locked && client?.assigned_to && client?.assigned_to !== agentId) {
    throw new Error("Client is locked to another agent. Use transfer instead.");
  }

  // Assign
  await supabase
    .from("clients")
    .update({
      assigned_to: agentId,
      team_id: agent.team_id,
      is_locked: true,
      last_seen: new Date().toISOString()
    })
    .eq("phone", clientPhone);

  // Notify agent via WhatsApp
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const agentPhone = await getAgentPhone(agentId);
    if (agentPhone) {
      await twilioClient.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${agentPhone}`,
        body: `🔔 *New Lead Assigned — Bodla Bot*\n\nClient: ${client?.name || clientPhone}\nPhone: ${clientPhone}\n\nPlease follow up on this lead. Open your dashboard to view the full chat history.`
      });
    }
  } catch (err) {
    console.error("Agent notification failed:", err.message);
  }

  return { success: true, message: `Assigned to ${agent.full_name}` };
}

// ─── Transfer client from one agent to another ────────────────────────────────
async function transferClient(clientPhone, toAgentId, transferredBy, reason = null) {
  const { data: client } = await supabase
    .from("clients")
    .select("assigned_to, name")
    .eq("phone", clientPhone)
    .single();

  const fromAgentId = client?.assigned_to || null;

  // Get both agents info
  const { data: toAgent } = await supabase
    .from("users")
    .select("id, full_name, team_id")
    .eq("id", toAgentId)
    .single();

  if (!toAgent) throw new Error("Target agent not found");

  // Log the transfer
  await supabase.from("transfer_log").insert({
    client_phone: clientPhone,
    from_agent_id: fromAgentId,
    to_agent_id: toAgentId,
    transferred_by: transferredBy,
    reason
  });

  // Update client assignment
  await supabase
    .from("clients")
    .update({
      assigned_to: toAgentId,
      team_id: toAgent.team_id,
      is_locked: true,
      last_seen: new Date().toISOString()
    })
    .eq("phone", clientPhone);

  // Notify both agents
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const clientName = client?.name || clientPhone;

    // Notify new agent
    const newAgentPhone = await getAgentPhone(toAgentId);
    if (newAgentPhone) {
      await twilioClient.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${newAgentPhone}`,
        body: `🔄 *Chat Transferred To You — Bodla Bot*\n\nClient: ${clientName}\nPhone: ${clientPhone}\n${reason ? `Reason: ${reason}\n` : ""}\nOpen your dashboard to view the full conversation history.`
      });
    }

    // Notify old agent
    if (fromAgentId) {
      const oldAgentPhone = await getAgentPhone(fromAgentId);
      if (oldAgentPhone) {
        await twilioClient.messages.create({
          from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
          to: `whatsapp:${oldAgentPhone}`,
          body: `ℹ️ *Chat Transferred — Bodla Bot*\n\nClient: ${clientName} (${clientPhone}) has been transferred from you to ${toAgent.full_name}.${reason ? `\nReason: ${reason}` : ""}`
        });
      }
    }
  } catch (err) {
    console.error("Transfer notification failed:", err.message);
  }

  return { success: true, message: `Transferred to ${toAgent.full_name}` };
}

// ─── Get agent's WhatsApp number ──────────────────────────────────────────────
async function getAgentPhone(agentId) {
  const { data } = await supabase
    .from("users")
    .select("whatsapp_phone")
    .eq("id", agentId)
    .single();
  return data?.whatsapp_phone || null;
}

// ─── Plot rates ───────────────────────────────────────────────────────────────
async function getPlotRates() {
  const { data } = await supabase
    .from("plot_rates")
    .select("*, updated_by_user:updated_by(full_name)")
    .order("sector", { ascending: true });
  return data || [];
}

async function upsertPlotRate(sector, plotType, size, minPrice, maxPrice, notes, userId) {
  const { data: existing } = await supabase
    .from("plot_rates")
    .select("id")
    .eq("sector", sector)
    .eq("plot_type", plotType)
    .eq("size", size)
    .single();

  if (existing) {
    await supabase
      .from("plot_rates")
      .update({ min_price: minPrice, max_price: maxPrice, notes, updated_by: userId, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("plot_rates")
      .insert({ sector, plot_type: plotType, size, min_price: minPrice, max_price: maxPrice, notes, updated_by: userId });
  }
}

// ─── Brochures ────────────────────────────────────────────────────────────────
async function getBrochures() {
  const { data } = await supabase
    .from("brochures")
    .select("*")
    .order("project_name", { ascending: true });
  return data || [];
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getSetting(key) {
  const { data } = await supabase.from("settings").select("value").eq("key", key).single();
  return data?.value || null;
}

async function updateSetting(key, value, userId) {
  await supabase
    .from("settings")
    .upsert({ key, value, updated_by: userId, updated_at: new Date().toISOString() });
}

// ─── DROP B: INTENT ROUTING + AUTO-ASSIGNMENT ─────────────────────────────────

// Map a department code to a team id (PLOT → "Plot Trading", PROJECT → "Project Sales")
async function getTeamIdByDepartment(department) {
  const teamName = department === "PROJECT" ? "Project Sales" : "Plot Trading";
  const { data } = await supabase.from("teams").select("id").eq("name", teamName).single();
  return data?.id || null;
}

// Write a notification row (channel-agnostic: dashboard now, mobile/WhatsApp later)
async function createNotification(recipientId, type, clientPhone, title, body) {
  if (!recipientId) return;
  try {
    await supabase.from("notifications").insert({
      recipient_id: recipientId,
      type,
      client_phone: clientPhone,
      title,
      body,
    });
  } catch (err) {
    console.error("createNotification error:", err.message);
  }
}

// Pick an agent within a team using the configured strategy.
// round_robin = the active agent who was least-recently assigned a lead.
async function pickAgentForTeam(teamId) {
  if (!teamId) return null;

  const { data: agents } = await supabase
    .from("users")
    .select("id, full_name, team_id, is_active, role")
    .eq("team_id", teamId)
    .eq("role", "agent")
    .eq("is_active", true);

  if (!agents || agents.length === 0) return null;
  if (agents.length === 1) return agents[0];

  const strategy = (await getSetting("assignment_strategy")) || "round_robin";

  if (strategy === "round_robin") {
    // Count current open assignments per agent; pick the least-loaded.
    const counts = {};
    for (const a of agents) counts[a.id] = 0;
    const { data: openClients } = await supabase
      .from("clients")
      .select("assigned_to")
      .in("assigned_to", agents.map((a) => a.id));
    for (const c of openClients || []) {
      if (counts[c.assigned_to] !== undefined) counts[c.assigned_to]++;
    }
    agents.sort((a, b) => counts[a.id] - counts[b.id]);
    return agents[0];
  }

  // Fallback: random
  return agents[Math.floor(Math.random() * agents.length)];
}

// Main entry: route an escalated client to the right team + agent.
// Returns { assigned: bool, agent, teamId, department }.
async function autoAssignOnEscalation(clientPhone, clientName, department) {
  const teamId = await getTeamIdByDepartment(department);

  // Always stamp department + team + escalated_at, even if no agent is free.
  const baseUpdate = {
    department,
    team_id: teamId,
    escalated: true,
    escalated_at: new Date().toISOString(),
  };

  // If already locked to an agent, don't reassign — just ensure stamps exist.
  const { data: existing } = await supabase
    .from("clients")
    .select("assigned_to, is_locked")
    .eq("phone", clientPhone)
    .single();

  if (existing?.is_locked && existing?.assigned_to) {
    await supabase.from("clients").update(baseUpdate).eq("phone", clientPhone);
    return { assigned: false, alreadyAssigned: true, teamId, department };
  }

  const agent = await pickAgentForTeam(teamId);

  if (!agent) {
    // No agent available — leave in pool, stamps set so SLA scanner can chase a manager.
    await supabase.from("clients").update(baseUpdate).eq("phone", clientPhone);
    return { assigned: false, agent: null, teamId, department };
  }

  // Assign + lock + stamp assignment time
  await supabase
    .from("clients")
    .update({
      ...baseUpdate,
      assigned_to: agent.id,
      is_locked: true,
      agent_assigned_at: new Date().toISOString(),
    })
    .eq("phone", clientPhone);

  // Dashboard notification for the agent
  await createNotification(
    agent.id,
    "NEW_LEAD",
    clientPhone,
    "New lead assigned",
    `${clientName || clientPhone} needs follow-up (${department === "PROJECT" ? "Project Sales" : "Plot Trading"}).`
  );

  // WhatsApp the agent if they have a number
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const agentPhone = await getAgentPhone(agent.id);
    if (agentPhone) {
      await twilioClient.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${agentPhone}`,
        body: `🔔 *New Lead Assigned*\n\nClient: ${clientName || clientPhone}\nPhone: ${clientPhone}\nDept: ${department === "PROJECT" ? "Project Sales" : "Plot Trading"}\n\nPlease follow up. Open your dashboard for the full chat.`,
      });
    }
  } catch (err) {
    console.error("Agent WhatsApp notify failed:", err.message);
  }

  return { assigned: true, agent, teamId, department };
}

module.exports = {
  getLeads,
  assignClient,
  transferClient,
  getPlotRates,
  upsertPlotRate,
  getBrochures,
  getSetting,
  updateSetting,
  getTeamIdByDepartment,
  createNotification,
  pickAgentForTeam,
  autoAssignOnEscalation,
};