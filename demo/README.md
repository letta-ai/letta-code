To setup the demo, do the following.

1. in one terminal, run 
bun run src/index.ts analytics 

and then navigate to http://127.0.0.1:45454 to see the live analytics.

2. In another two terminals, kick off: 
LETTA_LOCAL_ANALYTICS_URL=http://127.0.0.1:45454 letta --backend local --new-agent --model anthropic/claude-opus-4-7 --personality tutorial --demo-script demo/local-demo-script.json

LETTA_LOCAL_ANALYTICS_URL=http://127.0.0.1:45454 letta --backend local --new-agent --model anthropic/claude-opus-4-8 --personality tutorial --demo-script demo/local-demo-script.json 

And then watch them and watch the analytics url.