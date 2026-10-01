import { Controller, Post, Body } from '@nestjs/common';
import { AppService } from './app.service.js';
import { ChatRequest } from './dto/ChatRequest.dto.js';
import { ChatResponse } from './dto/ChatResponse.dto.js';

@Controller('openai')
export class AppController {
  private readonly RAG_DIR = 'src/rag';

  constructor(private readonly appService: AppService) {}
  
  // 서버 시작 시 문서 인덱싱 수행
  async onModuleInit() {
    const ragDirectory = this.RAG_DIR;
    await this.appService.initializeRAGIndex(ragDirectory);
  }

  @Post('/chat')
  async chat(@Body() chatRequest: ChatRequest): Promise<ChatResponse> {
    try {
      const response = await this.appService.getChatResponse(chatRequest);

      return {
        success: true,
        message: response,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }  
  }
  @Post('/rag')
  async chatWithRAG(@Body() chatRequestBody: ChatRequest): Promise<ChatResponse> {
    try { 
    const answer = await this.appService.getChatResponseWithRAG(chatRequestBody);
    const response: ChatResponse = { success: true, message: answer };
    return response
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }  
  }
  @Post('/reset-rag')
  async resetRAG() {
    const ragDirectory = this.RAG_DIR;  
    await this.appService.resetRAGSystem(ragDirectory);
    return { message: 'RAG 시스템이 성공적으로 초기화되었습니다.' };
  }

}