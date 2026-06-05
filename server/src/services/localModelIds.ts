export function toLocalModelId(platform: string, modelId: string): string {
  return `${platform}/${modelId}`;
}

export function parseLocalModelId(id: string): { platform: string; modelId: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return {
    platform: id.slice(0, slash),
    modelId: id.slice(slash + 1),
  };
}
