export function deliveryRetryStorageKey(
  documentType: "invoice" | "quote",
  documentId: string,
  recipient: string,
  subject: string,
) {
  const request = `${recipient.trim().toLowerCase()}\u0000${subject.trim()}`;
  return `pastagansa:delivery:${documentType}:${documentId}:${encodeURIComponent(request)}`;
}

export function reusableDeliveryKey(
  storedKey: string | null,
  deliveries: readonly { idempotencyKey: string; status: string }[],
) {
  if (!storedKey) return null;
  return deliveries.some((delivery) => delivery.idempotencyKey === storedKey && delivery.status === "FAILED")
    ? null
    : storedKey;
}
