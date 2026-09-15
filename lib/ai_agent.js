'use strict';
const { getToolsForUser, getToolByName } = require('./ai_tools');
const { callGemini } = require('./gemini');

/**
 * Intelligent Conversational Engine & Tool Dispatcher
 * Supports:
 * - Role-Gated Execution
 * - Natural Language Intent Parsing & Slot-Filling
 * - Confirmation summary generation for write operations
 * - Execution & natural language summary synthesis
 */

function parseNaturalDate(str) {
  if (!str) return null;
  const lower = str.toLowerCase().trim();
  const now = new Date();
  
  if (lower === 'today') return now.toISOString().slice(0, 10);
  if (lower === 'tomorrow') {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (lower.includes('next monday')) {
    const d = new Date();
    const day = d.getDay();
    const diff = (8 - day) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  const isoMatch = lower.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return str;
}

async function processChatMessage(user, message, sessionState = {}) {
  const allowedTools = getToolsForUser(user);

  // 1. Check if user is confirming a pending write action
  if (sessionState && sessionState.pendingConfirmation) {
    const cleanMsg = message.trim().toLowerCase();
    if (['yes', 'confirm', 'proceed', 'sure', 'submit', 'ok', 'do it', 'y'].includes(cleanMsg)) {
      const pending = sessionState.pendingConfirmation;
      const tool = getToolByName(pending.toolName);
      if (!tool) return { text: 'Action cancelled: tool definition missing.', state: {} };

      try {
        const result = await tool.execute({ user }, pending.args);
        const summaryText = result.message || 'Action executed successfully.';
        return {
          text: summaryText,
          executedResult: result,
          state: {}
        };
      } catch (err) {
        return {
          text: 'Execution failed: ' + err.message,
          state: {}
        };
      }
    } else if (['no', 'cancel', 'stop', "don't", 'n'].includes(cleanMsg)) {
      return { text: 'Action cancelled. How else can I assist you?', state: {} };
    }
  }

  // 2. Query / Intent matching
  const lowerMsg = message.toLowerCase();

  // Query: Team Late Today
  if (lowerMsg.includes('late') || lowerMsg.includes('tardy') || lowerMsg.includes('clocked in late')) {
    const tool = allowedTools.find(t => t.name === 'get_team_late_today');
    if (!tool) return { text: 'I am sorry, but viewing team late arrivals requires a Manager or Admin role.' };
    const res = await tool.execute({ user }, {});
    if (res.late_count === 0) {
      return { text: `Good news! None of your team members are late today (${res.today}).` };
    }
    const names = res.late_list.map(a => `• **${a.name}** (${a.department}): Clocked in at ${a.clock_in}`).join('\n');
    return { text: `There are **${res.late_count}** team member(s) who clocked in late today (${res.today}):\n\n${names}` };
  }

  // Query: Team Absence Today
  if (lowerMsg.includes('absent') || lowerMsg.includes('who is away') || lowerMsg.includes('who is on leave')) {
    const tool = allowedTools.find(t => t.name === 'get_team_absence_today');
    if (!tool) return { text: 'I am sorry, but viewing team absence requires a Manager or Admin role.' };
    const res = await tool.execute({ user }, {});
    if (res.absent_count === 0) {
      return { text: `Good news! None of your team members are absent or on leave today (${res.total_team_members} team members present).` };
    }
    const names = res.absent_list.map(a => `• **${a.name}** (${a.department}): ${a.reason}`).join('\n');
    return { text: `There are **${res.absent_count}** team member(s) absent or on leave today (${res.today}):\n\n${names}` };
  }

  // Query: Leave Balance
  if (lowerMsg.includes('leave balance') || lowerMsg.includes('how many days of leave') || lowerMsg.includes('my balance')) {
    const tool = allowedTools.find(t => t.name === 'check_leave_balance');
    const res = await tool.execute({ user }, {});
    const items = res.balances.map(b => `• **${b.leave_type}**: ${b.balance_days} / ${b.entitled_days} days remaining`).join('\n');
    return { text: `Here is your current leave balance for ${res.year}:\n\n${items}` };
  }

  // 3. System & Policy Knowledge Base (General HRMS Questions)
  if (lowerMsg.includes('what can you do') || lowerMsg.includes('capabilities') || lowerMsg.includes('what tools') || lowerMsg === 'help') {
    const toolList = allowedTools.map(t => `• **${t.label}**: ${t.description}`).join('\n');
    return {
      text: `Hello ${user.name}! As a **${user.permission_tier.toUpperCase()}** user, here is everything I can do for you:\n\n### 🛠️ Available Features for Your Tier:\n${toolList}\n\n### 💬 Quick Examples You Can Ask Me:\n• *"What is my leave balance?"*\n• *"Get my payslip summary"*\n• *"Check my claim entitlement"*\n• *"Help me apply annual leave for 2026-10-15 to 2026-10-16"*\n• *"Submit a claim for $150 medical bill"*\n${user.permission_tier === 'manager' || user.permission_tier === 'admin' || user.permission_tier === 'super_admin' ? `• *"How many staff are absent today?"*\n• *"How many staff are late today?"*\n• *"Approve leave application #12"*` : ''}\n\n• *"How can I link API to this HRMS?"*\n• *"What are the company claim limits?"*`,
      state: {}
    };
  }

  const systemKB = [
    {
      keywords: ['link api', 'connect api', 'api key', 'external api', 'api integration', 'integrate api'],
      answer: `To link external APIs or AI LLMs to StaffHub HRMS:\n\n1. **Configure Environment Variables**:\n   Set \`GEMINI_API_KEY\` or \`OPENAI_API_KEY\` or \`ANTHROPIC_API_KEY\` in your environment or \`.env\` file.\n\n2. **API Endpoint Integration**:\n   StaffHub exposes backend REST endpoints (e.g. \`POST /api/assistant/chat\` or \`POST /api/attendance/clock\`). You can call these endpoints from external services by sending a valid JSON payload along with the \`hrms_session\` cookie.\n\n3. **Custom Tool Definition**:\n   You can register new function tools in \`lib/ai_tools.js\` by providing \`name\`, \`description\`, \`allowedTiers\`, and an \`async execute(ctx, args)\` function.`
    },
    {
      keywords: ['policy', 'claim limit', 'mileage rate', 'cutoff', 'setting'],
      answer: `StaffHub system policies and limits are managed under **Settings > Claim Setting** and **System Setting**:\n\n• **Mileage Rate**: RM 0.60 / km (configurable)\n• **Late Cutoff**: 09:15 AM\n• **Default Limits**: Outpatient RM1,000 | Dental RM500 | Optical RM300`
    },
    {
      keywords: ['payroll', 'payslip', 'epf', 'socso', 'pcb'],
      answer: `StaffHub calculates Malaysian statutory contributions automatically during payroll runs (EPF, SOCSO, EIS, PCB). Payslips can be downloaded under **Payroll > My Payslip** or queried right here by asking *"What is my payslip summary?"*.`
    },
    {
      keywords: ['headcount', 'license', 'headcount limit'],
      answer: `Headcount license limits are controlled under **Settings > System Setting**. When the active employee limit is reached, adding new staff is blocked until a Super Admin updates the license key.`
    }
  ];

  for (const item of systemKB) {
    if (item.keywords.some(k => lowerMsg.includes(k))) {
      return { text: item.answer, state: {} };
    }
  }

  // 4. Try Gemini (if API key is configured) — full function-calling integration
  const geminiResult = await callGemini(user, message, sessionState);
  if (geminiResult) {
    // Merge history from Gemini result into returned state
    return geminiResult;
  }

  // 5. Static fallback (no Gemini key set)
  const toolList = allowedTools.map(t => `• **${t.label}**: ${t.description}`).join('\n');
  const geminiConfigured = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';
  const aiNote = geminiConfigured
    ? ''
    : '\n\n> ⚡ **Tip**: Add your `GEMINI_API_KEY` to the `.env` file to enable full AI-powered conversational responses.';

  return {
    text: `Hello **${user.name}**! I am your StaffHub AI Assistant (${user.permission_tier.toUpperCase()} Tier).\n\nHere is what I can do for you:\n${toolList}\n\nTry asking:\n• *"What is my leave balance?"*\n• *"Help me apply annual leave for 2026-10-15 to 2026-10-16"*\n• *"Submit a claim for $150 medical bill"*${user.permission_tier === 'manager' || user.permission_tier === 'admin' || user.permission_tier === 'super_admin' ? '\n• *"How many staff are absent today?"*' : ''}${aiNote}`,
    state: {}
  };
}

module.exports = {
  processChatMessage,
  parseNaturalDate,
};
