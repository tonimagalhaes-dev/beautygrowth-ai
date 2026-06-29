import { IsString, IsOptional, IsArray, IsNumber, IsDateString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class RAGChunkInfoDto {
  @IsString()
  chunkId: string;

  @IsString()
  documentId: string;

  @IsNumber()
  score: number;
}

export class LogRAGQueryDto {
  @IsOptional()
  @IsString()
  traceId?: string;

  @IsString()
  agentId: string;

  @IsString()
  query: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RAGChunkInfoDto)
  chunksReturned: RAGChunkInfoDto[];

  @IsString()
  finalPrompt: string;

  @IsString()
  response: string;

  @IsNumber()
  durationMs: number;

  @IsOptional()
  @IsDateString()
  timestamp?: string;
}
