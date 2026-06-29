import { Kafka, Consumer, KafkaMessage } from "kafkajs";

export abstract class MessageConsumerBase {
  kafka: Kafka;
  consumer: Consumer;

  constructor(kafkaClient: Kafka, consumerGroupId: string) {
    this.kafka = kafkaClient;
    this.consumer = this.kafka.consumer({ groupId: consumerGroupId });
  }

  async start(topics: string[], fromBeginning?: boolean) {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics, fromBeginning });
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        return await this.handleMessage(topic, partition, message);
      },
    });
  }

  abstract handleMessage(
    topic: string,
    partition: number,
    message: KafkaMessage
  ): Promise<void>;
}
