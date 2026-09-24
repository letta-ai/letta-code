import { parseArgs } from "node:util";
import { actingUserRequestOptions } from "@/agent/acting-user";
import { isLocalAgentId } from "@/agent/agent-id";
import { isLocalBackendEnabled } from "@/backend";
import { apiRequest } from "@/backend/api/request";
import {
  getRuntimeActingUserAssertion,
  getRuntimeActingUserId,
} from "@/runtime-context";
import { settingsManager } from "@/settings-manager";

type UserDetails = {
  id: string;
  name: string;
  email: string;
  image_url: string;
  is_api_created?: boolean;
};

type OwnerResponse = {
  owner: UserDetails | null;
};

type OrganizationSharingResponse = {
  level: "none" | "organization" | "public";
  sharedWithOrganization: boolean;
  defaultRole: "admin" | "editor" | "analyst";
};

type SharedUserGrant = {
  user_id: string;
  role: "admin" | "editor" | "analyst";
  user: UserDetails | null;
};

type SharedUsersResponse = {
  users: SharedUserGrant[];
};

type PeerGrant = {
  agent_id: string;
  role: string;
};

type PeersResponse = {
  sandbox_api_key_exists: boolean;
  peers: PeerGrant[];
};

type AgentDetailsResponse = {
  name: string;
  hidden?: boolean | null;
};

type PeerGrantDetails = PeerGrant & {
  name: string;
};

export interface PermissionsReport {
  agent_id: string;
  report_scope: "configured_direct_access_only";
  exhaustive_effective_access: false;
  owner: UserDetails | null;
  organization_sharing: {
    level: OrganizationSharingResponse["level"];
    shared_with_organization: boolean;
    default_role: OrganizationSharingResponse["defaultRole"];
  };
  explicit_shared_users: SharedUserGrant[];
  direct_incoming_peer_grants: PeerGrantDetails[];
  direct_outgoing_peer_grants: PeerGrantDetails[];
}

interface PermissionsSubcommandDependencies {
  initializeSettings?: () => Promise<void>;
  request?: typeof apiRequest;
  isLocalBackend?: () => boolean;
  getActingUserId?: () => string | undefined;
}

function printUsage(): void {
  console.log(`Usage:
  letta permissions [--agent <id>]

Report configured access for a Letta Cloud agent as JSON. The report includes
owner, organization sharing, explicit user shares, and direct incoming/outgoing
peer grants. It is not an exhaustive calculation of effective access.

Target precedence: --agent, LETTA_AGENT_ID, then AGENT_ID.

Options:
  --agent <id>   Agent to inspect
  -h, --help     Show this help`);
}

export function resolvePermissionsAgentId(
  explicitAgentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    [explicitAgentId, env.LETTA_AGENT_ID, env.AGENT_ID]
      .map((value) => value?.trim())
      .find((value): value is string => Boolean(value)) ?? ""
  );
}

async function filterVisiblePeerGrants(
  incoming: PeerGrant[],
  outgoing: PeerGrant[],
  request: typeof apiRequest,
  options: Parameters<typeof apiRequest>[3],
): Promise<{ incoming: PeerGrantDetails[]; outgoing: PeerGrantDetails[] }> {
  const peerIds = [
    ...new Set([...incoming, ...outgoing].map((grant) => grant.agent_id)),
  ];
  const details = await Promise.all(
    peerIds.map(async (peerId) => {
      try {
        const agent = await request<AgentDetailsResponse>(
          "GET",
          `/v1/agents/${encodeURIComponent(peerId)}`,
          undefined,
          options,
        );
        return [peerId, agent.hidden === true ? null : agent.name] as const;
      } catch {
        // Match the Cloud UI: unresolved peer agents do not render.
        return [peerId, null] as const;
      }
    }),
  );
  const visiblePeerNames = new Map(
    details.filter(
      (entry): entry is readonly [string, string] => entry[1] !== null,
    ),
  );
  const enrich = (grant: PeerGrant): PeerGrantDetails | null => {
    const name = visiblePeerNames.get(grant.agent_id);
    return name ? { ...grant, name } : null;
  };

  return {
    incoming: incoming.map(enrich).filter((grant) => grant !== null),
    outgoing: outgoing.map(enrich).filter((grant) => grant !== null),
  };
}

export async function buildPermissionsReport(
  agentId: string,
  request: typeof apiRequest = apiRequest,
  actingUserId: string | undefined = getRuntimeActingUserId(),
  actingUserAssertion: string | undefined = getRuntimeActingUserAssertion(),
): Promise<PermissionsReport> {
  const encodedAgentId = encodeURIComponent(agentId);
  const path = `/v1/agents/${encodedAgentId}`;
  const options =
    actingUserRequestOptions(actingUserId, actingUserAssertion) ?? {};
  const [owner, organizationSharing, sharedUsers, incoming, outgoing] =
    await Promise.all([
      request<OwnerResponse>("GET", `${path}/owner`, undefined, options),
      request<OrganizationSharingResponse>(
        "GET",
        `${path}/sharing-settings`,
        undefined,
        options,
      ),
      request<SharedUsersResponse>(
        "GET",
        `${path}/shared-users`,
        undefined,
        options,
      ),
      request<PeersResponse>("GET", `${path}/peers`, undefined, {
        ...options,
        query: { relationship: "shared_with_agent" },
      }),
      request<PeersResponse>("GET", `${path}/peers`, undefined, {
        ...options,
        query: { relationship: "accessible_by_agent" },
      }),
    ]);
  const visiblePeers = await filterVisiblePeerGrants(
    incoming.peers,
    outgoing.peers,
    request,
    options,
  );

  return {
    agent_id: agentId,
    report_scope: "configured_direct_access_only",
    exhaustive_effective_access: false,
    owner: owner.owner,
    organization_sharing: {
      level: organizationSharing.level,
      shared_with_organization: organizationSharing.sharedWithOrganization,
      default_role: organizationSharing.defaultRole,
    },
    explicit_shared_users: sharedUsers.users,
    direct_incoming_peer_grants: visiblePeers.incoming,
    direct_outgoing_peer_grants: visiblePeers.outgoing,
  };
}

export async function runPermissionsSubcommand(
  argv: string[],
  deps: PermissionsSubcommandDependencies = {},
): Promise<number> {
  let values: { agent?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        agent: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 1;
  }

  if (values.help) {
    printUsage();
    return 0;
  }

  const agentId = resolvePermissionsAgentId(values.agent);
  if (!agentId) {
    console.error(
      JSON.stringify({
        error:
          "Agent id required: pass --agent <id> or set LETTA_AGENT_ID/AGENT_ID.",
      }),
    );
    return 1;
  }

  if (
    (deps.isLocalBackend ?? isLocalBackendEnabled)() ||
    isLocalAgentId(agentId)
  ) {
    console.error(
      JSON.stringify({
        error:
          "Permissions reporting is only available for Letta Cloud agents.",
      }),
    );
    return 1;
  }

  try {
    await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
    const report = await buildPermissionsReport(
      agentId,
      deps.request ?? apiRequest,
      (deps.getActingUserId ?? getRuntimeActingUserId)(),
    );
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return 1;
  }
}
