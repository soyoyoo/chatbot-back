import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { RedisService } from './infra/redis/redis.service.js';
import { ChatRequest } from './dto/ChatRequest.dto.js';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  private readonly OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
  private readonly OPENAI_MODEL = 'gpt-4o-mini';
  constructor(private readonly redisService: RedisService) {
  }

  async getChatResponse(userMessage: ChatRequest): Promise<string> {
    try {
      this.logger.log(
        JSON.stringify({
          event: `OpenAI API 요청 시작 - Conversation ID: ${userMessage.timestamp}`,
          prompt: userMessage.prompt, // 🛠️ prompt -> userMessage로 수정
          timestamp: new Date().toISOString(),
        }),
      );
      const chatHistory = await this.getChatHistory(userMessage.timestamp);
      this.logger.debug(`Retrieved chat history - Length: ${chatHistory.length}`);
      
      chatHistory.push({ role: 'user', content: userMessage.prompt });
      const chatRequest = {
        model: this.OPENAI_MODEL,
        messages: [
          { role: 'developer', content: 'You are a helpful assistant.' },
          ...chatHistory
        ]
      };
      const response = await axios.post(
        this.OPENAI_API_URL,
        chatRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.OPENAI_API_KEY}`,
          },
        },
      );

      this.logger.log(
        JSON.stringify({
          event: `OpenAI API 요청 성공 - Conversation ID: ${userMessage.timestamp}`,
          prompt: userMessage.prompt,
          timestamp: new Date().toISOString(),
        }),
      );

      // Chat Completions 응답 구조 추출
      const result = response.data.choices[0].message.content || '응답을 받지 못했습니다.';

      chatHistory.push({ role: 'assistant', content: result });
      await this.saveChatHistory(userMessage.timestamp, chatHistory);
      this.logger.debug(`Chat history saved - Conversation ID: ${userMessage.timestamp}`);

      return result;
    } catch (error) {
      this.logger.error( 
        JSON.stringify({
          event: 'OpenAI API 요청 실패',
          prompt: userMessage.prompt, 
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        }),
      );
      throw error;
    }
  }

  async getChatResponseWithRAG(userMessage: ChatRequest): Promise<string> {
    try {
      // 1. 사용자 질문에 대한 임베딩 생성
    const questionEmbedding = await this.createEmbedding(userMessage.prompt);

    // 2. 벡터 검색 수행
    const searchResults = await this.redisService.searchVector('my-tech-chatbot', questionEmbedding);

    // 3. 검색 결과 추출 (옵셔널 체이닝 및 방어 로직 적용)
    const documents = searchResults?.documents || [];
    
    // Redis JSON 구조에 맞춰 안전하게 text 추출
    const relevantDocs = documents
      .map((doc: any) => doc?.value?.text || '')
      .filter((text: string) => text.trim().length > 0)
      .join('\n\n');

    // 4. 관련 문서 유무에 따른 시스템 프롬프트 작성
    const systemPrompt = relevantDocs
      ? `다음은 질문과 관련된 참고 정보입니다:\n${relevantDocs}\n\n위 참고 정보를 바탕으로 사용자의 질문에 친절하고 정확하게 답변해 주세요.`
      : `You are a helpful assistant. Please answer the user's question politely.`;

    this.logger.debug(`System prompt: ${systemPrompt}`);
      this.logger.log(
        JSON.stringify({
          event: `OpenAI API 요청 시작 - Conversation ID: ${userMessage.timestamp}`,
          prompt: userMessage.prompt, // 🛠️ prompt -> userMessage로 수정
          timestamp: new Date().toISOString(),
        }),
      );
      const chatHistory = await this.getChatHistory(userMessage.timestamp);
      this.logger.debug(`Retrieved chat history - Length: ${chatHistory.length}`);
      
      chatHistory.push({ role: 'user', content: userMessage.prompt });
      const chatRequest = {
        model: this.OPENAI_MODEL,
        messages: [
          { role: 'developer', content: systemPrompt },
          ...chatHistory
        ]
      };
      const response = await axios.post(
        this.OPENAI_API_URL,
        chatRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.OPENAI_API_KEY}`,
          },
        },
      );

      this.logger.log(
        JSON.stringify({
          event: `OpenAI API 요청 성공 - Conversation ID: ${userMessage.timestamp}`,
          prompt: userMessage.prompt,
          timestamp: new Date().toISOString(),
        }),
      );

      // Chat Completions 응답 구조 추출
      const result = response.data.choices[0].message.content || '응답을 받지 못했습니다.';

      chatHistory.push({ role: 'assistant', content: result });
      await this.saveChatHistory(userMessage.timestamp, chatHistory);
      this.logger.debug(`Chat history saved - Conversation ID: ${userMessage.timestamp}`);

      return result;
    } catch (error) {
      this.logger.error( 
        JSON.stringify({
          event: 'OpenAI API 요청 실패',
          prompt: userMessage.prompt, 
          error: (error as Error).message,
          timestamp: new Date().toISOString(),
        }),
      );
      throw error;
    }
  }


  getHello(): string {
    return 'Hello!';
  }

  private async getChatHistory(conversationId: string): Promise<Array<{ role: string; content: string }>> {
    this.logger.debug(`Fetching chat history - Conversation ID: ${conversationId}`);
    const history = await this.redisService.get(conversationId);
    if (!history) {
      this.logger.debug(`No existing chat history found for conversation ID: ${conversationId}`);
      return [];
    }
    const parsedHistory = JSON.parse(history);
    this.logger.debug(`Chat history retrieved - Messages count: ${parsedHistory.length}`);
    return parsedHistory;
  }

  private async saveChatHistory(conversationId: string, chatHistory: Array<{ role: string; content: string }>): Promise<void> {
    this.logger.debug(`Saving chat history - Conversation ID: ${conversationId}, Messages count: ${chatHistory.length}`);
    await this.redisService.set(conversationId, JSON.stringify(chatHistory));
    this.logger.debug(`Chat history saved successfully - Conversation ID: ${conversationId}`);
  }

  async initializeRAGIndex(directoryPath: string): Promise<void> {
    try {
      this.logger.log('RAG 인덱스 초기화 시작...');
      // 벡터 인덱스 생성
      await this.redisService.createVectorIndex('my-tech-chatbot');
      this.logger.log('벡터 인덱스 생성 완료');
      
      // 문서 로드 및 인덱싱
      await this.loadAndIndexDocuments(directoryPath);
      this.logger.log('문서 인덱싱 완료');
    } catch (error) {
      this.logger.error('RAG 초기화 중 오류 발생:', error);
      throw new Error('RAG 시스템 초기화 중 오류가 발생했습니다.');
    }
  }

  private async loadAndIndexDocuments(directoryPath: string): Promise<void> {
    try {
      // 디렉토리 내의 모든 파일 읽기
      const files = await fs.readdir(directoryPath);
      
      for (const file of files) {
        if (file.endsWith('.txt')) {
          const filePath = path.join(directoryPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // 문서를 적절한 크기로 분할 (예: 1000자)
          const chunks = this.splitDocument(content, 600);
          
          for (const [index, chunk] of chunks.entries()) {
            // 각 청크에 대한 임베딩 생성
            const embedding = await this.createEmbedding(chunk);
            
            // Redis에 저장
            const docKey = `doc:${path.basename(file, '.txt')}:${index}`;
            await this.redisService.addVectorData(docKey, embedding, chunk);
            
            this.logger.debug(`Indexed chunk ${index + 1}/${chunks.length} of ${file}`);
          }
        }
      }
    } catch (error) {
      this.logger.error('문서 인덱싱 중 오류 발생:', error);
      throw new Error('문서 인덱싱 중 오류가 발생했습니다.');
    }
  }

  private async createEmbedding(text: string): Promise<number[]> {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
          input: text,
          model: 'text-embedding-ada-002'
        },
        {
          headers: {
            'Authorization': `Bearer ${this.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data.data[0].embedding;
    } catch (error) {
      this.logger.error('임베딩 생성 중 오류 발생:', error);
      throw new Error('임베딩 생성 중 오류가 발생했습니다.');
    }
  }

  private splitDocument(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    let currentChunk = '';
    
    // 문장 단위로 분할
    const sentences = text.split(/(?<=[.!?])\s+/);
    
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length <= chunkSize) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        currentChunk = sentence;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  async resetRAGSystem(directoryPath: string): Promise<void> {
    try {
      this.logger.log('RAG 시스템 초기화 시작...');
      
      // 벡터 인덱스 초기화
      await this.redisService.resetVectorIndex('my-tech-chatbot');
      
      // 문서 다시 로드 및 인덱싱
      await this.loadAndIndexDocuments(directoryPath);
      
      this.logger.log('RAG 시스템 초기화 완료');
    } catch (error) {
      this.logger.error('RAG 시스템 초기화 중 오류 발생:', error);
      throw new Error('RAG 시스템 초기화 중 오류가 발생했습니다.');
    }
  }


}