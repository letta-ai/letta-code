/**
 * Utility to parse AWS credentials from ~/.aws/credentials
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface AwsProfile {
  name: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

/**
 * Parse AWS credentials file and return list of profiles
 */
export async function parseAwsCredentials(): Promise<AwsProfile[]> {
  const credentialsPath = join(homedir(), ".aws", "credentials");
  const configPath = join(homedir(), ".aws", "config");

  const profiles: Map<string, AwsProfile> = new Map();

  // Parse credentials file
  try {
    const content = await readFile(credentialsPath, "utf-8");
    parseIniFile(content, profiles, false);
  } catch {
    // Credentials file doesn't exist or can't be read
  }

  // Parse config file for region info
  try {
    const content = await readFile(configPath, "utf-8");
    parseIniFile(content, profiles, true);
  } catch {
    // Config file doesn't exist or can't be read
  }

  return Array.from(profiles.values());
}

/**
 * Parse INI-style AWS config/credentials file
 */
function parseIniFile(
  content: string,
  profiles: Map<string, AwsProfile>,
  isConfig: boolean,
): void {
  const lines = content.split("\n");
  let currentProfile: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    // Check for profile header
    const headerMatch = trimmed.match(/^\[(.+)\]$/);
    if (headerMatch) {
      let profileName = headerMatch[1];
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

    // Parse key=value pairs
    if (currentProfile) {
      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        const profile = profiles.get(currentProfile)!;

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

/**
 * Get a specific profile by name
 */
export async function getAwsProfile(
  profileName: string,
): Promise<AwsProfile | null> {
  const profiles = await parseAwsCredentials();
  return profiles.find((p) => p.name === profileName) || null;
}

/**
 * Get list of available profile names
 */
export async function getAwsProfileNames(): Promise<string[]> {
  const profiles = await parseAwsCredentials();
  return profiles.map((p) => p.name);
}
