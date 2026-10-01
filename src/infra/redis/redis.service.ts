import { Injectable, Inject, OnModuleDestroy, Logger } from '@nestjs/common';
// 🛠️ 1. RedisClientType을 type-only import로 분리 (TS1272 해결)
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: RedisClientType,
  ) {}

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.redis.set(key, value, { EX: ttl });
    } else {
      await this.redis.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async createVectorIndex(indexName: string): Promise<void> {
    try {
      const schema = [
        'FT.CREATE', indexName,
        'ON', 'JSON',
        'PREFIX', '1', 'doc:',
        'SCHEMA',
        '$.text', 'AS', 'text', 'TEXT',
        '$.vector', 'AS', 'vector', 'VECTOR', 
        'HNSW', '6',
        'TYPE', 'FLOAT32',
        'DIM', '1536',
        'DISTANCE_METRIC', 'COSINE'
      ];
      await this.redis.sendCommand(schema);
      this.logger.log(`벡터 인덱스 ${indexName} 생성 완료`);
    } catch (e) {
      // 🛠️ 3. (e as Error) 타입 단언 적용 (TS18046 해결)
      const error = e as Error;
      if (error.message.includes('Index already exists')) {
        this.logger.log('인덱스가 이미 존재합니다.');
        return;
      }
      this.logger.error('벡터 인덱스 생성 중 오류:', error);
      throw error;
    }
  }

  // 핵심 로직 - 내가 만든 문서를 redis에 벡터 임베딩
  async addVectorData(key: string, vector: number[], text: string): Promise<void> {
    try {
      await this.redis.json.set(key, '$', {
        text: text,
        vector: vector
      });
      this.logger.debug(`데이터 저장 완료: ${key}`);
    } catch (e) {
      this.logger.error(`데이터 저장 중 오류 (key: ${key}):`, e);
      throw e;
    }
  }

  // 핵심 로직 - OpenAI 벡터 결과를 바탕으로 벡터검색 수행
  async searchVector(indexName: string, vector: number[], limit: number = 5): Promise<any> {
    const query = `*=>[KNN ${limit} @vector $vector AS score]`;
    const results = await this.redis.ft.search(
      indexName,
      query,
      {
        PARAMS: {
          vector: Buffer.from(new Float32Array(vector).buffer)
        },
        SORTBY: 'score', // 검색 결과 정렬 기준
        DIALECT: 2, // 벡터 검색 쿼리 문법 버전
        RETURN: ['text', 'score'] // 검색 결과 반환 필드
      }
    );
    return results;
  }

  async resetVectorIndex(indexName: string): Promise<void> {
    try {
      // 기존 인덱스가 있다면 삭제
      const indices = await this.redis.ft._LIST();
      if (indices.includes(indexName)) {
        await this.redis.ft.DROPINDEX(indexName);
      }
      
      // 벡터 관련 키들 삭제
      const keys = await this.redis.keys(`doc:*`);
      if (keys.length > 0) {
        await this.redis.del(keys);
      }

      // 새로운 인덱스 생성
      await this.createVectorIndex(indexName);
      
      this.logger.log(`Vector index ${indexName} has been reset successfully`);
    } catch (error) {
      this.logger.error('벡터 인덱스 초기화 중 오류 발생:', error);
      throw new Error('벡터 인덱스 초기화 중 오류가 발생했습니다.');
    }
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}