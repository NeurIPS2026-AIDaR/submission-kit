const NOTE_ID = /^[A-Za-z0-9_-]{6,128}$/;

export function normalizeOpenReviewUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("A valid OpenReview forum URL is required");
  }
  if (url.protocol !== "https:" || url.hostname !== "openreview.net" || url.port || url.username || url.password || url.pathname !== "/forum") {
    throw new Error("Use an https://openreview.net/forum?id=... URL");
  }
  const id = url.searchParams.get("id") ?? "";
  if (!NOTE_ID.test(id)) throw new Error("OpenReview forum URL has an invalid id");
  return `https://openreview.net/forum?id=${encodeURIComponent(id)}`;
}
