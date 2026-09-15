'use strict';

/**
 * lib/gemini.js — Google Gemini API client for StaffHub HRMS AI Assistant
 *
 * Features:
 *  - Gemini function calling (native tool use) so Gemini can trigger HRMS actions
 *  - Full HRMS system prompt with user context (name, tier, company)
 *  - Multi-turn conversation history
 *  - Automatic tool execution with two-phase confirmation for write actions
 */

const { getToolsForUser, getToolByName } = require('./ai_tools');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * Build the system instruction string for Gemini.
 * Includes who the user is, their tier, and the rules of engagement.
 */
function buildSystemInstruction(user) {
  const today = new Date().toISOString().slice(0, 10);
  const tier = user.permission_tier;
  const isManager = ['manager', 'admin', 'super_admin', 'hiring_manager'].includes(tier);

  return `You are the StaffHub HRMS AI Assistant — a conversational HR helper embedded inside the StaffHub Human Resource Management System.

## Current User
- **Name**: ${user.name}
- **Employee ID**: ${user.id}
- **Permission Tier**: ${tier}${isManager ? ' (has manager-level access)' : ''}
- **Today's Date**: ${today}

## Your Role
You help employees and managers with HR tasks conversationally. You can:
- Answer questions about leave balances, payslips, claim entitlements, attendance
- Help submit leave applications, claims, overtime pre-approvals, out-of-office notices
- Answer general HR policy questions
- For managers: show team absence, late arrivals, and approve leave requests

## Behaviour Rules
1. **For read/query tools**: Execute immediately and present the result clearly.
2. **For write/action tools**: Always summarise what you are about to do in plain language and ask the user to confirm before calling the tool. Never silently execute write actions.
3. **Ask one question at a time** — don't fire a wall of questions. If you need details (dates, amount, category), ask for the most critical missing piece first.
4. **Be concise and friendly** — use markdown for structure (bold key info, bullet points for lists), but keep responses short and helpful.
5. **Formatting Multi-Record Data**: When a query or tool result returns multiple structured records (e.g. leave balances across categories, team absence list, payslips, claim entitlements), format them into a clean markdown table with headers instead of bullet points or plain text paragraphs.
6. **Permission gating**: Only use tools available to the user's tier. If the user asks for something outside their tier, politely explain and suggest what they CAN do.
7. **Dates**: When a user says "today", "tomorrow", or "next Monday", resolve to the actual ISO date before calling tools.
8. **Do not hallucinate data** — if a tool returns no data, say so honestly. Never invent leave balances, payslip figures, or employee counts.

## Company Context
This is a Malaysian company using StaffHub HRMS. Statutory contributions include EPF, SOCSO, EIS, and PCB. Leave types typically include Annual, Medical, Emergency, and Compassionate leave. Claims categories include Medical, Dental, Optical, and Mileage.`;
}

/**
 * Convert HRMS tool definitions into Gemini function declarations.
 * Only exposes tools available to this user's permission tier.
 */
function buildGeminiTools(user) {
  const tools = getToolsForUser(user);
  if (tools.length === 0) return [];

  const functionDeclarations = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters && Object.keys(tool.parameters.properties || {}).length > 0
      ? {
          type: 'OBJECT',
          properties: Object.fromEntries(
            Object.entries(tool.parameters.properties).map(([k, v]) => [
              k,
              { type: (v.type || 'string').toUpperCase(), description: v.description || k }
            ])
          ),
          required: tool.parameters.required || []
        }
      : { type: 'OBJECT', properties: {} }
  }));

  return [{ functionDeclarations }];
}

/**
 * Convert our internal history format to Gemini's `contents` array format.
 * history = [{ role: 'user'|'model', text: string }]
 */
function buildContents(history, newUserMessage) {
  const contents = [];

  for (const entry of history) {
    contents.push({
      role: entry.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: entry.text }]
    });
  }

  // Add the new user message
  contents.push({ role: 'user', parts: [{ text: newUserMessage }] });

  return contents;
}

/**
 * Main entry point: send a message to Gemini, handle function calls, and return
 * a plain { text, confirmation, state } response compatible with processChatMessage().
 *
 * @param {object} user        - The authenticated user object
 * @param {string} message     - The user's current message
 * @param {object} sessionState - Session state (includes history, pendingConfirmation)
 * @returns {Promise<{ text: string, confirmation?: object, state: object }>}
 */
async function callGemini(user, message, sessionState = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return null; // Signal to caller that Gemini is not configured
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;

  const history = (sessionState && sessionState.history) || [];
  const contents = buildContents(history, message);
  const tools = buildGeminiTools(user);

  const requestBody = {
    systemInstruction: { parts: [{ text: buildSystemInstruction(user) }] },
    contents,
    tools,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1024,
    },
    toolConfig: {
      functionCallingConfig: { mode: 'AUTO' }
    }
  };

  let response;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[Gemini] API error:', res.status, errText);
      return null;
    }

    response = await res.json();
  } catch (err) {
    console.error('[Gemini] Fetch failed:', err.message);
    return null;
  }

  const candidate = response.candidates?.[0];
  if (!candidate) {
    console.error('[Gemini] No candidate in response');
    return null;
  }

  const parts = candidate.content?.parts || [];

  // ── Handle function call ──────────────────────────────────────────────────
  const fnCall = parts.find(p => p.functionCall);
  if (fnCall) {
    const { name: toolName, args: toolArgs } = fnCall.functionCall;
    const tool = getToolByName(toolName);

    if (!tool) {
      return {
        text: `I tried to call the tool \`${toolName}\` but it could not be found. Please try again.`,
        state: { history }
      };
    }

    // READ tools — execute immediately and return result summary to Gemini for a
    // natural-language response
    if (tool.type === 'read') {
      let toolResult;
      try {
        toolResult = await tool.execute({ user }, toolArgs || {});
      } catch (err) {
        console.error('[Gemini] Tool execution error:', err.message);
        return {
          text: `There was an error retrieving that information: ${err.message}`,
          state: { history }
        };
      }

      // Send the tool result back to Gemini for a friendly summary
      const followUpContents = [
        ...contents,
        candidate.content,
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: toolName,
              response: { name: toolName, content: toolResult }
            }
          }]
        }
      ];

      let summaryText;
      try {
        const summaryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: buildSystemInstruction(user) }] },
            contents: followUpContents,
            tools,
            generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
          })
        });
        const summaryData = await summaryRes.json();
        summaryText = summaryData.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
      } catch (e) {
        console.warn('[Gemini] Summary follow-up failed:', e.message);
      }

      if (!summaryText) {
        // Fallback: format the raw tool result as JSON-like text
        summaryText = `Here is what I found:\n\n\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\``;
      }

      const newHistory = [
        ...history,
        { role: 'user', text: message },
        { role: 'assistant', text: summaryText }
      ];

      return { text: summaryText, state: { history: newHistory } };
    }

    // WRITE tools — two-phase: show confirmation card, don't execute yet
    const confirmPayload = { toolName, args: toolArgs || {} };
    const detailLines = Object.entries(toolArgs || {}).map(([k, v]) => ({
      label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      value: String(v)
    }));

    // Ask Gemini to write a human-readable summary of what it's about to do
    let confirmText = `I am ready to **${tool.label}** with the following details:\n\n${detailLines.map(d => `- **${d.label}**: ${d.value}`).join('\n')}\n\nShall I proceed?`;

    try {
      const summaryRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemInstruction(user) }] },
          contents: [
            ...contents,
            {
              role: 'user',
              parts: [{
                text: `You are about to call the tool "${tool.label}" with these arguments: ${JSON.stringify(toolArgs)}. Write a brief, friendly confirmation message asking the user to confirm before you proceed. Mention the key details. End with "Shall I proceed?"`
              }]
            }
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 256 }
        })
      });
      const summaryData = await summaryRes.json();
      const generated = summaryData.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
      if (generated) confirmText = generated;
    } catch (e) {
      // Use the fallback confirmText built above
    }

    return {
      text: confirmText,
      confirmation: {
        tool_name: toolName,
        title: `Confirm: ${tool.label}`,
        details: detailLines
      },
      state: {
        history: [...history, { role: 'user', text: message }],
        pendingConfirmation: confirmPayload
      }
    };
  }

  // ── Plain text response ───────────────────────────────────────────────────
  const textPart = parts.find(p => p.text);
  const responseText = textPart?.text || 'I could not generate a response. Please try rephrasing your question.';

  const newHistory = [
    ...history,
    { role: 'user', text: message },
    { role: 'assistant', text: responseText }
  ];

  // Keep history bounded (last 20 turns = 10 exchanges)
  const trimmedHistory = newHistory.slice(-20);

  return { text: responseText, state: { history: trimmedHistory } };
}

module.exports = { callGemini };
