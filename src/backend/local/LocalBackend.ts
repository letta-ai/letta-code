import { FakeHeadlessBackend } from "../dev/FakeHeadlessBackend";

export interface LocalBackendOptions {
  storageDir: string;
  defaultAgentId?: string;
}

export class LocalBackend extends FakeHeadlessBackend {
  constructor(options: LocalBackendOptions) {
    super(options.defaultAgentId, undefined, {
      storageDir: options.storageDir,
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });
  }
}
