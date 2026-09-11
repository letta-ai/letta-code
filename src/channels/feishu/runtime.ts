import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "@/channels/runtime-deps";
import type { FeishuDomain } from "@/channels/types";
import {
  FEISHU_API_DOMAINS,
  FEISHU_RUNTIME_MODULE,
  type LarkRuntimeModuleLike,
} from "./internal-types";

let loadFeishuModuleOverride: (() => Promise<LarkRuntimeModuleLike>) | null =
  null;

export function __testOverrideLoadFeishuModule(
  override: (() => Promise<LarkRuntimeModuleLike>) | null,
): void {
  loadFeishuModuleOverride = override;
}

export async function loadFeishuModule(): Promise<LarkRuntimeModuleLike> {
  if (loadFeishuModuleOverride) {
    return loadFeishuModuleOverride();
  }
  return loadChannelRuntimeModule<LarkRuntimeModuleLike>(
    "feishu",
    FEISHU_RUNTIME_MODULE,
  );
}

export function isFeishuRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("feishu");
}

export async function installFeishuRuntime(): Promise<void> {
  await installChannelRuntime("feishu");
}

export async function ensureFeishuRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("feishu");
}

export function resolveFeishuSdkDomain(
  domain: FeishuDomain,
  runtime: LarkRuntimeModuleLike,
): unknown {
  if (domain === "lark") {
    return runtime.Domain?.Lark ?? FEISHU_API_DOMAINS.lark;
  }
  return runtime.Domain?.Feishu ?? FEISHU_API_DOMAINS.feishu;
}
