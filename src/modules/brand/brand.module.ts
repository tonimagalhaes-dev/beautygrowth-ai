import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BrandController } from './brand.controller';
import { BrandService } from './services/brand.service';
import { StorageService } from './services/storage.service';
import { BrandIdentity } from './entities/brand-identity.entity';
import { STORAGE_SERVICE } from './interfaces/brand.interface';

@Module({
  imports: [
    TypeOrmModule.forFeature([BrandIdentity]),
    EventEmitterModule.forRoot(),
  ],
  controllers: [BrandController],
  providers: [
    BrandService,
    {
      provide: STORAGE_SERVICE,
      useClass: StorageService,
    },
  ],
  exports: [BrandService],
})
export class BrandModule {}
