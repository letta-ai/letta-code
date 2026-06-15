#!/usr/bin/env bash
set -euo pipefail
export HOME="${HOME:-/data}"
export LETTA_LOCAL_BACKEND_EXPERIMENTAL="${LETTA_LOCAL_BACKEND_EXPERIMENTAL:-1}"
export LETTA_LOCAL_BACKEND_DIR="${LETTA_LOCAL_BACKEND_DIR:-/data/lc-local-backend}"
mkdir -p "$HOME/.letta/channels/slack" "$LETTA_LOCAL_BACKEND_DIR"
CLI="./node_modules/.bin/letta"
if [ ! -x "$CLI" ]; then
  CLI="letta"
fi
if [ ! -s /data/fin-agent-id ]; then
  "$CLI" --backend local agents create --name Fin --personality blank --description "Finance assistant for Sarah and Charles" --tags finance,slack > /tmp/fin-agent.json
  node -e "const fs=require('fs'); const text=fs.readFileSync('/tmp/fin-agent.json','utf8'); const start=text.indexOf('{'); const agent=JSON.parse(text.slice(start)); fs.writeFileSync('/data/fin-agent-id', agent.id);"
fi
AGENT_ID=$(cat /data/fin-agent-id)
node -e "const fs=require('fs'); const dir=process.env.HOME + '/.letta/channels/slack'; fs.mkdirSync(dir,{recursive:true}); const now=new Date().toISOString(); const allowed=(process.env.SLACK_ALLOWED_USERS||'').split(',').map(s=>s.trim()).filter(Boolean); const account={channel:'slack',accountId:'fin',displayName:'Fin',enabled:true,mode:'socket',botToken:process.env.SLACK_BOT_TOKEN||'',appToken:process.env.SLACK_APP_TOKEN||'',agentId:process.env.LETTA_AGENT_ID||process.env.FIN_AGENT_ID||'$AGENT_ID',defaultPermissionMode:'unrestricted',dmPolicy:process.env.SLACK_DM_POLICY||'allowlist',allowedUsers:allowed,createdAt:now,updatedAt:now}; fs.writeFileSync(dir + '/accounts.json', JSON.stringify({accounts:[account]}, null, 2));"
exec "$CLI" server --backend local --channels slack --install-channel-runtimes --debug
