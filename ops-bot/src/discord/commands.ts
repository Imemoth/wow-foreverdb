export const COMMAND_NAME = "azerdex";
export const INCIDENT_ID_RE = /^INC-\d{6}-[A-Z0-9]{4}$/;
export const MAINT_COMPONENT_RE = /^(\*|g6:job|supabase:reporting|bot:schedule|source:[a-z0-9][a-z0-9-]{0,63})$/;

/**
 * Slash command definitions. READ-AND-ACKNOWLEDGE ONLY: no command restarts, backfills, deploys, edits data, cron or settings.
 * `default_member_permissions: "0"` hides the command from everyone until a server admin grants it to the operator role
 * (defence in depth: the Worker independently enforces guild + operator authorization on every interaction).
 */
export const COMMAND_DEFINITIONS = [{
  name: COMMAND_NAME, description: "AzerDex operations (read and acknowledge only)", type: 1, dm_permission: false, default_member_permissions: "0",
  options: [
    { type: 1, name: "status", description: "Current monitoring status" },
    { type: 1, name: "incidents", description: "List incidents",
      options: [{ type: 3, name: "filter", description: "Which incidents", required: false, choices: [{ name: "active", value: "active" }, { name: "acknowledged", value: "acknowledged" }, { name: "resolved", value: "resolved" }] }] },
    { type: 1, name: "incident", description: "Show one incident",
      options: [{ type: 3, name: "id", description: "Incident id, e.g. INC-261106-AB12", required: true, max_length: 20 }] },
    { type: 1, name: "ack", description: "Acknowledge an open incident (does not change health)",
      options: [{ type: 3, name: "id", description: "Incident id", required: true, max_length: 20 }, { type: 3, name: "note", description: "Optional note", required: false, max_length: 200 }] },
    { type: 1, name: "maintenance", description: "Mute NOTIFICATIONS for a component (monitoring continues)",
      options: [
        { type: 3, name: "action", description: "start, end or list", required: true, choices: [{ name: "start", value: "start" }, { name: "end", value: "end" }, { name: "list", value: "list" }] },
        { type: 3, name: "component", description: "Component id or * for all", required: false, max_length: 80 },
        { type: 4, name: "minutes", description: "Duration (5 to 1440)", required: false, min_value: 5, max_value: 1440 },
        { type: 3, name: "reason", description: "Reason", required: false, max_length: 200 },
      ] },
  ],
}] as const;
