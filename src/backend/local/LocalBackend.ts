import { FakeHeadlessBackend } from "../dev/FakeHeadlessBackend";
import type { LocalStoreOptions } from "./LocalStore";

export interface LocalBackendOptions {
  storageDir: string;
  defaultAgentId?: string;
}

export class LocalBackend extends FakeHeadlessBackend {
  constructor(options: LocalBackendOptions) {
    const storeOptions: LocalStoreOptions = {
      storageDir: options.storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    };
    super(options.defaultAgentId, undefined, storeOptions);
  }
}
