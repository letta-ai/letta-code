import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AwsProfile {
  name: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

export async function parseAwsCredentials(): Promise<AwsProfile[]> {
  const credentialsPath = join(homedir(), ".aws", "credentials");
  const configPath = join(homedir(), ".aws", "config");

  const profiles: Map<string, AwsProfile> = new Map();

  try {
    const content = await readFile(credentialsPath, "utf-8");
    parseIniFile(content, profiles, false);
  } catch {
    // Credentials file doesn't exist or can't be read
  }

  try {
    const content = await readFile(configPath, "utf-8");
    parseIniFile(content, profiles, true);
  } catch {
    // Config file doesn't exist or can't be read
  }

  return Array.from(profiles.values());
}

function parseIniFile(
  content: string,
  profiles: Map<string, AwsProfile>,
  isConfig: boolean,
): void {
  const lines = content.split("\n");
  let currentProfile: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const headerMatch = trimmed.match(/^\[(.+)\]$/);
    if (headerMatch?.[1]) {
      let profileName: string = headerMatch[1];
      // In config file, profiles are prefixed with "profile " (except default)
      if (isConfig && profileName.startsWith("profile ")) {
        profileName = profileName.slice(8);
      }
      currentProfile = profileName;

      if (!profiles.has(profileName)) {
        profiles.set(profileName, { name: profileName });
      }
      continue;
    }

    if (currentProfile) {
      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (kvMatch?.[1] && kvMatch[2] !== undefined) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        const profile = profiles.get(currentProfile);
        if (!profile) continue;

        switch (key) {
          case "aws_access_key_id":
            profile.accessKeyId = value;
            break;
          case "aws_secret_access_key":
            profile.secretAccessKey = value;
            break;
          case "region":
            profile.region = value;
            break;
        }
      }
    }
  }
}
