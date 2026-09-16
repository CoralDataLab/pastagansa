export function deliveryRetryStorageKey(
  documentType: "invoice" | "quote",
  documentId: string,
  recipient: string,
  subject: string,
) {
  const request = `${recipient.trim().toLowerCase()}\u0000${subject.trim()}`;
  return `pastagansa:delivery:${documentType}:${documentId}:${encodeURIComponent(request)}`;
}
