const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
const ws = require("ws");

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    realtime: { transport: ws },
  }
);

async function getClient(phone) {
  const { data } = await supabase
    .from("clients")
    .select("*")
    .eq("phone", phone)
    .single();
  return data || null;
}

async function createClient(phone, name) {
  const { data } = await supabase
    .from("clients")
    .upsert(
      { phone, name: name || null, last_seen: new Date().toISOString() },
      { onConflict: "phone" }
    )
    .select()
    .single();
  return data;
}

async function updateClientName(phone, name) {
  await supabase.from("clients").update({ name }).eq("phone", phone);
}

async function markEscalated(phone, agentRequested = false) {
  await supabase
    .from("clients")
    .update({ 
      escalated: true, 
      agent_requested: agentRequested,
      last_seen: new Date().toISOString() 
    })
    .eq("phone", phone);
}

async function getAllClients(user = null) {
  let query = supabase
    .from("clients")
    .select("*")
    .order("last_seen", { ascending: false });

  // Scope by role: agents see only their own, managers see their team, admins see all.
  if (user) {
    if (user.role === "agent") {
      query = query.eq("assigned_to", user.id);
    } else if (user.role === "manager") {
      query = query.eq("team_id", user.team_id);
    }
  }

  const { data } = await query;
  return data || [];
}

async function saveMessage(phone, role, content, sender = null) {
  const row = { phone, role, content };
  if (sender) {
    row.sender_id = sender.id || null;
    row.sender_name = sender.full_name || sender.name || null;
    row.sender_role = sender.role || null;
  }
  await supabase.from("messages").insert(row);
  await supabase
    .from("clients")
    .update({ last_seen: new Date().toISOString() })
    .eq("phone", phone);
}

async function getChatHistory(phone) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at, sender_name, sender_role")
    .eq("phone", phone)
    .order("created_at", { ascending: true });
  return data || [];
}

module.exports = {
  supabase,  // ← ADD THIS LINE
  getClient,
  createClient,
  updateClientName,
  markEscalated,
  getAllClients,
  saveMessage,
  getChatHistory,
};