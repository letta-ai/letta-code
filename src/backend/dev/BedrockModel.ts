import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModel } from "ai";
import { getAwsProfile } from "../../utils/aws-credentials";
import { getLocalProviderRecordByName } from "../local/LocalProviderAuthStore";
import {
  createLocalProviderFetch,
  type LocalProviderTimeout,
} from "../local/LocalProviderTimeout";

export interface BedrockModelFactoryOptions {
  model?: string;
  storageDir?: string;
  providerName: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
  createModel?: (model: string) => LanguageModel;
}

async function resolveProfileCredentials(profileName: string): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
}> {
  const profile = await getAwsProfile(profileName);
  if (!profile?.accessKeyId || !profile.secretAccessKey) {
    throw new Error(`AWS profile "${profileName}" is missing credentials.`);
  }
  return {
    accessKeyId: profile.accessKeyId,
    secretAccessKey: profile.secretAccessKey,
  };
}

function createDefaultBedrockModel(options: {
  model: string;
  storageDir?: string;
  providerName: string;
  fetch?: typeof fetch;
  timeout?: LocalProviderTimeout;
}): LanguageModel {
  const record = getLocalProviderRecordByName(
    options.providerName,
    options.storageDir,
  );
  const apiKey = record?.auth.type === "api" ? record.auth.key : undefined;
  const secretAccessKey = apiKey || process.env.AWS_SECRET_ACCESS_KEY;
  const accessKeyId = record?.access_key ?? process.env.AWS_ACCESS_KEY_ID;
  const region = record?.region ?? process.env.AWS_REGION;
  const profile = record?.profile ?? process.env.AWS_PROFILE;

  const provider = createAmazonBedrock({
    region,
    fetch: createLocalProviderFetch({
      fetch: options.fetch,
      timeout: options.timeout ?? record?.timeout,
    }),
    ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
    ...(profile && !accessKeyId && !secretAccessKey
      ? { credentialProvider: () => resolveProfileCredentials(profile) }
      : {}),
  });
  return provider(options.model);
}

export function createBedrockModelFactory(
  options: BedrockModelFactoryOptions,
): () => LanguageModel {
  const model = options.model;
  if (!model) {
    throw new Error("No model configured for AWS Bedrock.");
  }
  const createModel =
    options.createModel ??
    ((model: string) =>
      createDefaultBedrockModel({
        model,
        storageDir: options.storageDir,
        providerName: options.providerName,
        fetch: options.fetch,
        timeout: options.timeout,
      }));
  return () => createModel(model);
}
