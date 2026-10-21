import type { PersonalityAssetId } from "./personality-presets";

declare const __AGENT_PRESETS_BUNDLE__: boolean | undefined;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function tutorProfilePictureUrl(): URL {
  if (typeof __AGENT_PRESETS_BUNDLE__ !== "undefined") {
    return new URL("../assets/tutor-profile.png", import.meta.url);
  }
  const sourceAssetPath = "../../assets/tutor-profile.png";
  return new URL(sourceAssetPath, import.meta.url);
}

async function readAsset(asset: URL): Promise<string> {
  if (asset.protocol === "file:") {
    if (typeof Bun === "undefined") {
      throw new Error("Personality asset is unavailable");
    }
    return encodeBase64(new Uint8Array(await Bun.file(asset).arrayBuffer()));
  }

  const response = await fetch(asset);
  if (!response.ok) {
    throw new Error(`Failed to load personality asset: ${response.status}`);
  }
  return encodeBase64(new Uint8Array(await response.arrayBuffer()));
}

export async function getPersonalityAssetBase64(
  assetId: PersonalityAssetId,
): Promise<string> {
  switch (assetId) {
    case "tutor-profile":
      return readAsset(tutorProfilePictureUrl());
  }
}
