import { Module, Global, Logger } from '@nestjs/common';
import { createClient } from 'redis';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  // 의존성 주입 설정
  // @Inject('REDIS_CLIENT')로 다른 클래스에서 사용할 수 있음
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: async () => {
        const logger = new Logger('RedisClient');
        const client = createClient({
          url: process.env.REDIS_URL || 'redis://localhost:6379',
          RESP: 2,
          socket: {
            reconnectStrategy: (retries) => {
              logger.warn(`Redis 재연결 시도 중... (시도 횟수: ${retries})`);
              return Math.min(retries * 1000, 10000); // 최대 10초까지 재시도 간격 증가
            },
          },
          // Redis Stack 관련 설정 추가
          database: 0,
        });

      // redis 연결처리
        client.on('error', (err) => {
          logger.error(`Redis 에러 발생: ${err.message}`);
        });

        client.on('connect', () => {
          logger.log('Redis 서버에 연결되었습니다.');
        });

        client.on('reconnecting', () => {
          logger.warn('Redis 서버에 재연결 중...');
        });

        await client.connect();
        return client;
      },
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}