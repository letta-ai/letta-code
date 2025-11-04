import { Letta } from "@letta-ai/letta-client";

async function checkAgent() {
  const client = new Letta({ token: process.env.LETTA_API_KEY });
  
  // Check both agents
  const agentIds = [
    "agent-aab12188-2a42-4fa3-a5a8-a35fb7518db2", // User's agent
    "agent-bb90887a-39b3-4b3e-a21e-17eafe6ab6de", // This conversation's agent
  ];

  for (const agentId of agentIds) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Retrieving agent ${agentId}...`);
    const agent = await client.agents.retrieve(agentId);

    console.log(`\nAgent has ${agent.tools?.length || 0} tools:`);
    for (const tool of agent.tools || []) {
      console.log(
        `- ${tool.name}: default_requires_approval=${tool.default_requires_approval}`
      );
    }

    // Check for Bash tool specifically
    const bashTool = agent.tools?.find((t) => t.name === "Bash");
    if (bashTool) {
      console.log("\nBash tool details:");
      console.log(
        `  default_requires_approval: ${bashTool.default_requires_approval}`
      );
    }

    // Check tool_rules
    console.log(`\nAgent tool_rules: ${agent.tool_rules?.length || 0} rules`);
    
    // Look for requires_approval rules specifically
    const approvalRules = agent.tool_rules?.filter(
      (rule: any) => rule.type === "requires_approval"
    );
    console.log(`  Approval rules: ${approvalRules?.length || 0}`);
    
    if (approvalRules && approvalRules.length > 0) {
      console.log("\nTools with approval rules:");
      for (const rule of approvalRules) {
        console.log(`  - ${rule.tool_name}`);
      }
    }
    
    console.log("\nAll tool_rules:");
    if (agent.tool_rules && agent.tool_rules.length > 0) {
      console.log(JSON.stringify(agent.tool_rules, null, 2));
    }
  }
}

checkAgent().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
