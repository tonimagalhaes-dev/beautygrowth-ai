import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BrandIdentity, ColorEntry } from '../entities/brand-identity.entity';
import { CreateBrandDto } from '../dto/create-brand.dto';
import { UpdateBrandDto } from '../dto/update-brand.dto';
import {
  LogoUploadResult,
  ClinicContext,
  IStorageService,
  STORAGE_SERVICE,
} from '../interfaces/brand.interface';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_LOGO_FORMATS = ['image/png', 'image/jpeg', 'image/svg+xml'];
const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MIN_LOGO_DIMENSION = 200; // 200px

export interface ImageDimensions {
  width: number;
  height: number;
}

@Injectable()
export class BrandService {
  private readonly logger = new Logger(BrandService.name);

  constructor(
    @InjectRepository(BrandIdentity)
    private readonly brandRepository: Repository<BrandIdentity>,
    @Inject(STORAGE_SERVICE)
    private readonly storageService: IStorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(tenantId: string, dto: CreateBrandDto): Promise<BrandIdentity> {
    this.validateBrandData(dto);

    const existing = await this.brandRepository.findOne({ where: { tenantId } });
    if (existing) {
      throw new BadRequestException(
        'Brand identity already exists for this tenant. Use update instead.',
      );
    }

    const brand = this.brandRepository.create({
      tenantId,
      voiceTone: dto.voiceTone,
      colorPalette: dto.colorPalette as ColorEntry[],
      targetAudience: dto.targetAudience,
      differentials: dto.differentials,
      values: dto.values,
      logoUrl: dto.logo || null,
    });

    const saved = await this.brandRepository.save(brand);

    this.eventEmitter.emit('brand.updated', {
      tenantId,
      brandId: saved.id,
      action: 'created',
      timestamp: new Date(),
    });

    this.logger.log(`Brand identity created for tenant ${tenantId}`);
    return saved;
  }

  async update(
    brandId: string,
    tenantId: string,
    dto: UpdateBrandDto,
  ): Promise<BrandIdentity> {
    const brand = await this.brandRepository.findOne({
      where: { id: brandId, tenantId },
    });

    if (!brand) {
      throw new NotFoundException('Brand identity not found');
    }

    if (dto.colorPalette) {
      this.validateColorPalette(dto.colorPalette as ColorEntry[]);
    }
    if (dto.differentials) {
      this.validateArrayItems(dto.differentials, 200, 'differentials');
    }
    if (dto.values) {
      this.validateArrayItems(dto.values, 200, 'values');
    }

    if (dto.voiceTone !== undefined) brand.voiceTone = dto.voiceTone;
    if (dto.colorPalette !== undefined) brand.colorPalette = dto.colorPalette as ColorEntry[];
    if (dto.targetAudience !== undefined) brand.targetAudience = dto.targetAudience;
    if (dto.differentials !== undefined) brand.differentials = dto.differentials;
    if (dto.values !== undefined) brand.values = dto.values;
    if (dto.logo !== undefined) brand.logoUrl = dto.logo || null;

    const saved = await this.brandRepository.save(brand);

    this.eventEmitter.emit('brand.updated', {
      tenantId,
      brandId: saved.id,
      action: 'updated',
      timestamp: new Date(),
    });

    this.logger.log(`Brand identity updated for tenant ${tenantId}`);
    return saved;
  }

  async getByTenant(tenantId: string): Promise<BrandIdentity | null> {
    return this.brandRepository.findOne({ where: { tenantId } });
  }

  async uploadLogo(
    file: Express.Multer.File,
    getImageDimensions?: (buffer: Buffer) => Promise<ImageDimensions>,
  ): Promise<LogoUploadResult> {
    // Validate format
    if (!ALLOWED_LOGO_FORMATS.includes(file.mimetype)) {
      throw new BadRequestException(
        `Logo format not supported. Allowed formats: PNG, JPG, SVG`,
      );
    }

    // Validate size
    if (file.size > MAX_LOGO_SIZE_BYTES) {
      throw new BadRequestException(
        `Logo size exceeds maximum of 5MB. Current size: ${(file.size / 1024 / 1024).toFixed(2)}MB`,
      );
    }

    // Validate dimensions (skip for SVG as they are vector-based)
    let dimensions: ImageDimensions = { width: 200, height: 200 };

    if (file.mimetype !== 'image/svg+xml') {
      if (getImageDimensions) {
        dimensions = await getImageDimensions(file.buffer);
      } else {
        // Use sharp for dimension checking
        try {
          const sharp = await import('sharp');
          const metadata = await sharp.default(file.buffer).metadata();
          dimensions = {
            width: metadata.width || 0,
            height: metadata.height || 0,
          };
        } catch {
          throw new BadRequestException(
            'Unable to read image dimensions. Ensure the file is a valid image.',
          );
        }
      }

      if (
        dimensions.width < MIN_LOGO_DIMENSION ||
        dimensions.height < MIN_LOGO_DIMENSION
      ) {
        throw new BadRequestException(
          `Logo dimensions must be at least ${MIN_LOGO_DIMENSION}x${MIN_LOGO_DIMENSION}px. Current dimensions: ${dimensions.width}x${dimensions.height}px`,
        );
      }
    }

    // Determine format
    const formatMap: Record<string, 'png' | 'jpg' | 'svg'> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/svg+xml': 'svg',
    };
    const format = formatMap[file.mimetype];

    // Upload to S3
    const key = `logos/${uuidv4()}.${format}`;
    const url = await this.storageService.upload(file.buffer, key, file.mimetype);

    return {
      url,
      format,
      sizeBytes: file.size,
      dimensions,
    };
  }

  async suggestOptions(field: string, context: ClinicContext): Promise<string[]> {
    // Stub implementation that returns mock suggestions
    // In production, this would call an AI service
    const suggestions: Record<string, string[]> = {
      voiceTone: [
        `Profissional e acolhedor, transmitindo confiança e cuidado personalizado para ${context.clinicName}`,
        `Moderno e sofisticado, com linguagem acessível que valoriza a autoestima das clientes`,
        `Empático e científico, combinando humanização com expertise técnica em ${context.specialties?.[0] || 'estética'}`,
      ],
      targetAudience: [
        `Mulheres de 25-45 anos, classe A/B, que buscam procedimentos estéticos minimamente invasivos`,
        `Profissionais de 30-55 anos que valorizam autocuidado e resultados naturais`,
        `Público feminino e masculino de 20-50 anos interessado em harmonização facial e corporal`,
      ],
      differentials: [
        'Atendimento personalizado com protocolos exclusivos',
        'Tecnologia de ponta com equipamentos de última geração',
        'Equipe multidisciplinar com especialistas renomados',
        'Ambiente acolhedor e resultados comprovados',
        'Acompanhamento pós-procedimento completo',
      ],
      values: [
        'Excelência e inovação em cada procedimento',
        'Ética e transparência com nossos pacientes',
        'Segurança como prioridade absoluta',
        'Valorização da beleza natural e autoestima',
        'Compromisso com resultados e satisfação',
      ],
    };

    return suggestions[field] || [
      `Sugestão 1 para ${field}`,
      `Sugestão 2 para ${field}`,
      `Sugestão 3 para ${field}`,
    ];
  }

  private validateBrandData(dto: CreateBrandDto): void {
    this.validateColorPalette(dto.colorPalette as ColorEntry[]);
    this.validateArrayItems(dto.differentials, 200, 'differentials');
    this.validateArrayItems(dto.values, 200, 'values');
  }

  private validateColorPalette(palette: ColorEntry[]): void {
    const hasPrimary = palette.some((color) => color.isPrimary);
    if (!hasPrimary) {
      throw new BadRequestException(
        'Color palette must have at least 1 primary color',
      );
    }
  }

  private validateArrayItems(
    items: string[],
    maxLength: number,
    fieldName: string,
  ): void {
    for (let i = 0; i < items.length; i++) {
      if (items[i].length > maxLength) {
        throw new BadRequestException(
          `Each item in ${fieldName} must be at most ${maxLength} characters. Item ${i + 1} has ${items[i].length} characters.`,
        );
      }
    }
  }
}
