const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
const ws = require("ws");

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: ws } }
);

const JWT_SECRET = process.env.JWT_SECRET || "bodlabot-secret-2026";

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(username, password) {
  try {
    console.log("🔐 Login attempt:", username);
    
    // Query user
    const { data: user, error: queryError } = await supabase
      .from("users")
      .select("id, username, full_name, role, team_id, is_active, password_hash")
      .eq("username", username)
      .single();

    console.log("📊 Query result:", queryError ? queryError.message : "User found");
    
    if (queryError || !user) {
      console.log("❌ User not found:", username);
      throw new Error("Invalid username or password");
    }

    if (!user.is_active) {
      console.log("❌ User inactive:", username);
      throw new Error("User account is inactive");
    }

    // Compare password
    console.log("🔑 Password comparison starting...");
    const isValid = await bcrypt.compare(password, user.password_hash);
    console.log("✅ Password valid:", isValid);
    
    if (!isValid) {
      throw new Error("Invalid username or password");
    }

    // Update last login
    await supabase
      .from("users")
      .update({ last_login: new Date().toISOString() })
      .eq("id", user.id);

    // Generate JWT
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role, 
        team_id: user.team_id, 
        full_name: user.full_name 
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    console.log("🎫 Token generated for:", username);

    return {
      token,
      user: { 
        id: user.id, 
        username: user.username, 
        role: user.role, 
        full_name: user.full_name, 
        team_id: user.team_id 
      }
    };
  } catch (err) {
    console.error("🚫 Login error:", err.message);
    throw err;
  }
}

// ─── Get current user ─────────────────────────────────────────────────────────
async function getMe(userId) {
  const { data: user } = await supabase
    .from("users")
    .select("id, username, full_name, role, team_id, is_active")
    .eq("id", userId)
    .single();
  return user;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(roles = []) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    console.log("🔍 Auth header:", authHeader ? authHeader.substring(0, 50) + "..." : "MISSING");
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("❌ No Bearer token");
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const token = authHeader.split(" ")[1];
      console.log("🔑 Token extracted:", token ? token.substring(0, 30) + "..." : "EMPTY");
      
      const decoded = jwt.verify(token, JWT_SECRET);
      console.log("✅ Token decoded:", decoded.username);
      req.user = decoded;
      
      if (roles.length > 0 && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      
      next();
    } catch (err) {
      console.error("❌ Token verify error:", err.message);
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

// ─── Create user ──────────────────────────────────────────────────────────────
async function createUser(username, password, fullName, role, teamId = null) {
  try {
    // Hash password
    const password_hash = await bcrypt.hash(password, 10);
    
    const { data, error } = await supabase
      .from("users")
      .insert({ 
        username, 
        password_hash, 
        full_name: fullName, 
        role, 
        team_id: teamId || null,
        is_active: true
      })
      .select()
      .single();
    
    if (error) throw new Error(error.message);
    
    return {
      id: data.id,
      username: data.username,
      full_name: data.full_name,
      role: data.role,
      team_id: data.team_id
    };
  } catch (err) {
    console.error("Create user error:", err.message);
    throw err;
  }
}

// ─── Get users ────────────────────────────────────────────────────────────────
async function getUsers(role = null, teamId = null) {
  try {
    let query = supabase
      .from("users")
      .select("id, username, full_name, role, team_id, is_active, last_login, created_at, whatsapp_phone");
    
    if (role) query = query.eq("role", role);
    if (teamId) query = query.eq("team_id", teamId);
    
    const { data, error } = await query.order("created_at", { ascending: false });
    
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.error("Get users error:", err.message);
    throw err;
  }
}

// ─── Get teams ────────────────────────────────────────────────────────────────
async function getTeams() {
  try {
    const { data, error } = await supabase
      .from("teams")
      .select("id, name, manager_id, created_at, manager:manager_id(id, full_name, username)")
      .order("created_at", { ascending: false });
    
    if (error) throw new Error(error.message);
    return data || [];
  } catch (err) {
    console.error("Get teams error:", err.message);
    throw err;
  }
}

// ─── Create team ──────────────────────────────────────────────────────────────
async function createTeam(name, managerId = null) {
  try {
    const { data, error } = await supabase
      .from("teams")
      .insert({ name, manager_id: managerId || null })
      .select()
      .single();
    
    if (error) throw new Error(error.message);
    
    // If manager assigned, update their team_id
    if (managerId) {
      await supabase
        .from("users")
        .update({ team_id: data.id })
        .eq("id", managerId);
    }
    
    return data;
  } catch (err) {
    console.error("Create team error:", err.message);
    throw err;
  }
}

// ─── Update user ──────────────────────────────────────────────────────────────
async function updateUser(id, fields) {
  try {
    const allowed = {};
    if (fields.full_name !== undefined) allowed.full_name = fields.full_name;
    if (fields.role !== undefined) allowed.role = fields.role;
    if (fields.team_id !== undefined) allowed.team_id = fields.team_id || null;
    if (fields.whatsapp_phone !== undefined) allowed.whatsapp_phone = fields.whatsapp_phone || null;
    if (fields.is_active !== undefined) allowed.is_active = fields.is_active;
    if (fields.username !== undefined) allowed.username = fields.username;
    // Optional password change
    if (fields.password) allowed.password_hash = await bcrypt.hash(fields.password, 10);

    const { data, error } = await supabase
      .from("users").update(allowed).eq("id", id)
      .select("id, username, full_name, role, team_id, is_active, whatsapp_phone").single();
    if (error) throw new Error(error.message);
    return data;
  } catch (err) {
    console.error("Update user error:", err.message);
    throw err;
  }
}

// ─── Delete user (auto-unassign their leads back to pool) ──────────────────────
async function deleteUser(id) {
  try {
    // Guard: don't allow deleting the last active admin
    const { data: target } = await supabase.from("users").select("role").eq("id", id).single();
    if (target?.role === "admin") {
      const { data: admins } = await supabase
        .from("users").select("id").eq("role", "admin").eq("is_active", true);
      if ((admins || []).length <= 1) {
        throw new Error("Cannot delete the last admin account.");
      }
    }

    // Auto-unassign: any clients assigned to this user go back to the pool
    await supabase
      .from("clients")
      .update({ assigned_to: null, is_locked: false })
      .eq("assigned_to", id);

    // If this user is a team manager, null out that reference
    await supabase.from("teams").update({ manager_id: null }).eq("manager_id", id);

    const { error } = await supabase.from("users").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  } catch (err) {
    console.error("Delete user error:", err.message);
    throw err;
  }
}

// ─── Update team ──────────────────────────────────────────────────────────────
async function updateTeam(id, fields) {
  try {
    const allowed = {};
    if (fields.name !== undefined) allowed.name = fields.name;
    if (fields.manager_id !== undefined) allowed.manager_id = fields.manager_id || null;

    const { data, error } = await supabase
      .from("teams").update(allowed).eq("id", id).select().single();
    if (error) throw new Error(error.message);

    // Keep the manager's team_id in sync
    if (fields.manager_id) {
      await supabase.from("users").update({ team_id: id }).eq("id", fields.manager_id);
    }
    return data;
  } catch (err) {
    console.error("Update team error:", err.message);
    throw err;
  }
}

// ─── Delete team (detach members + clients first) ─────────────────────────────
async function deleteTeam(id) {
  try {
    // Detach members from the team (don't delete the people)
    await supabase.from("users").update({ team_id: null }).eq("team_id", id);
    // Detach any clients routed to this team
    await supabase.from("clients").update({ team_id: null }).eq("team_id", id);

    const { error } = await supabase.from("teams").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return { success: true };
  } catch (err) {
    console.error("Delete team error:", err.message);
    throw err;
  }
}

module.exports = { 
  login, 
  getMe,
  requireAuth, 
  createUser, 
  getUsers, 
  getTeams, 
  createTeam,
  updateUser,
  deleteUser,
  updateTeam,
  deleteTeam
};