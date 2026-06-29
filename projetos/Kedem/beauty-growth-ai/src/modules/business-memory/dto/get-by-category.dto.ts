import { IsIn } from 'class-validator';
import { MemoryCategory } from '../entities/business-memory-entry.entity';

export class GetByCategoryDto {
  @IsIn(['brand', 'audience', 'campaigns', 'procedures', 'preferences'])
  category: MemoryCategory;
}
