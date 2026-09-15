'use strict';
const { processChatMessage } = require('../lib/ai_agent');
const { layout } = require('../lib/render');
const { redirect, sendJson, parseJsonBody } = require('../lib/util');

module.exports = function(router) {
  router.get('/assistant', async (ctx) => {
    const user = ctx.user;
    if (!user) return redirect(ctx.res, '/login');

    const isMgr = user.permission_tier === 'manager' || user.permission_tier === 'admin' || user.permission_tier === 'super_admin';

    const html = `
      <div class="max-w-4xl mx-auto space-y-6">
        <div class="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 p-6 flex items-center justify-between">
          <div class="flex items-center space-x-4">
            <div class="w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-950 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xl font-bold">
              ✨
            </div>
            <div>
              <h1 class="text-xl font-bold text-slate-900 dark:text-slate-100">StaffHub AI Assistant</h1>
              <p class="text-sm text-slate-500 dark:text-slate-400">Ask queries, check balances, apply for leave, or submit claims directly using natural language.</p>
            </div>
          </div>
          <span class="px-3 py-1 text-xs font-semibold rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 uppercase tracking-wider">
            ${user.permission_tier} Tier
          </span>
        </div>

        <!-- Suggestions -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onclick="sendSuggested('What is my leave balance?')" class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-indigo-500 hover:shadow-sm text-left transition">
            <span class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold uppercase block mb-1">Query</span>
            <span class="text-sm text-slate-800 dark:text-slate-200 font-medium">"What is my leave balance?"</span>
          </button>
          <button onclick="sendSuggested('Submit a claim for $150 medical bill on 2026-09-01')" class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-indigo-500 hover:shadow-sm text-left transition">
            <span class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold uppercase block mb-1">Action</span>
            <span class="text-sm text-slate-800 dark:text-slate-200 font-medium">"Submit a claim for $150 medical..."</span>
          </button>
          ${isMgr ? `
            <button onclick="sendSuggested('How many staff are absent today?')" class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-indigo-500 hover:shadow-sm text-left transition">
              <span class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold uppercase block mb-1">Manager Query</span>
              <span class="text-sm text-slate-800 dark:text-slate-200 font-medium">"How many staff are absent today?"</span>
            </button>
          ` : `
            <button onclick="sendSuggested('Check my claim entitlement')" class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-indigo-500 hover:shadow-sm text-left transition">
              <span class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold uppercase block mb-1">Query</span>
              <span class="text-sm text-slate-800 dark:text-slate-200 font-medium">"Check my claim entitlement"</span>
            </button>
          `}
        </div>

        <!-- Chat Container -->
        <div class="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 h-[500px] flex flex-col overflow-hidden">
          <div id="chatHistory" class="flex-1 p-6 overflow-y-auto space-y-4 bg-slate-50/50 dark:bg-slate-950/50">
            <div class="flex items-start space-x-3">
              <div class="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                AI
              </div>
              <div class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl rounded-tl-none p-4 shadow-sm text-sm text-slate-800 dark:text-slate-200 max-w-lg">
                Hello ${user.name}! I am your HR assistant. How can I help you today? You can ask about leave balances, payslips, claims, or ask me to perform actions for you.
              </div>
            </div>
          </div>

          <!-- Input Area -->
          <div class="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center space-x-3">
            <input type="text" id="chatInput" onkeydown="if(event.key==='Enter') sendMessage()" placeholder="Type a command or question..." class="flex-1 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <button onclick="sendMessage()" id="sendBtn" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition flex items-center space-x-1">
              <span>Send</span>
            </button>
          </div>
        </div>
      </div>

      <script>
        let currentState = null;

        function appendMessage(sender, text, confirmation) {
          const history = document.getElementById('chatHistory');
          const isUser = sender === 'user';
          
          let contentHtml = (typeof marked !== 'undefined') ? marked.parse(text) : text.replace(/\\n/g, '<br>');
          
          if (confirmation) {
            contentHtml += '<div class="mt-3 pt-3 border-t border-indigo-200 dark:border-indigo-800 flex space-x-2">' +
              '<button onclick="confirmAction(true)" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded text-xs font-semibold">Confirm & Submit</button>' +
              '<button onclick="confirmAction(false)" class="bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded text-xs font-semibold">Cancel</button>' +
            '</div>';
          }

          let msgHtml = '';
          if (isUser) {
            msgHtml = '<div class="flex items-start justify-end space-x-3">' +
              '<div class="bg-indigo-600 text-white rounded-2xl rounded-tr-none p-4 shadow-sm text-sm max-w-lg">' +
                contentHtml +
              '</div>' +
            '</div>';
          } else {
            msgHtml = '<div class="flex items-start space-x-3">' +
              '<div class="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold flex-shrink-0">' +
                'AI' +
              '</div>' +
              '<div class="chat-bubble bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl rounded-tl-none p-4 shadow-sm text-sm text-slate-800 dark:text-slate-200 max-w-lg overflow-x-auto">' +
                contentHtml +
              '</div>' +
            '</div>';
          }

          history.insertAdjacentHTML('beforeend', msgHtml);
          history.scrollTop = history.scrollHeight;
        }

        function sendSuggested(txt) {
          document.getElementById('chatInput').value = txt;
          sendMessage();
        }

        async function sendMessage() {
          const input = document.getElementById('chatInput');
          const msg = input.value.trim();
          if (!msg) return;

          appendMessage('user', msg);
          input.value = '';

          try {
            const res = await fetch('/api/assistant/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: msg, state: currentState })
            });
            const data = await res.json();
            currentState = data.state;
            appendMessage('assistant', data.text, data.confirmation);
          } catch (e) {
            appendMessage('assistant', 'Sorry, an error occurred while processing your request.');
          }
        }

        function confirmAction(isYes) {
          document.getElementById('chatInput').value = isYes ? 'yes' : 'no';
          sendMessage();
        }
      </script>
    `;

    ctx.res.writeHead(200, { 'Content-Type': 'text/html' });
    ctx.res.end(layout({ title: 'AI Assistant', user: ctx.user, activePath: '/assistant', body: html, url: ctx.url }));
  });

  router.post('/api/assistant/chat', async (ctx) => {
    const user = ctx.user;
    if (!user) {
      return sendJson(ctx.res, 401, { error: 'Unauthorized' });
    }

    const b = await parseJsonBody(ctx.req);
    try {
      const result = await processChatMessage(user, b.message || '', b.state || null);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      console.error('AI Assistant endpoint error:', err);
      sendJson(ctx.res, 500, { error: err.message });
    }
  });
};
