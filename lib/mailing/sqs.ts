import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { assertServerOnly } from "../server-only.js";
import { loadMailConfig } from "./config.js";
import type { EventQueue, QueuedMessage } from "./worker.js";

assertServerOnly("lib/mailing/sqs.ts");

/** Cola SQS con los eventos de SES (Configuration Set → SNS → SQS). Polling desde el worker: no hace falta endpoint público. */
export function createSqsEventQueue(): EventQueue | null {
  const config = loadMailConfig();
  if (!config.eventsQueueUrl || !config.region) return null;
  const client = new SQSClient({ region: config.region });
  const queueUrl = config.eventsQueueUrl;
  return {
    async receive(max: number): Promise<QueuedMessage[]> {
      const r = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
          WaitTimeSeconds: 10,
          VisibilityTimeout: 60,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        })
      );
      return (r.Messages ?? []).flatMap((m) =>
        m.Body && m.ReceiptHandle
          ? [{ id: m.MessageId ?? "", body: m.Body, receipt: m.ReceiptHandle, receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? "1") }]
          : []
      );
    },
    async delete(receipt: string): Promise<void> {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
    },
  };
}
