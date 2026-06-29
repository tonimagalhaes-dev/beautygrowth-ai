import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../services/storage.service';

// Mock the S3Client
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn().mockResolvedValue({}),
    })),
    PutObjectCommand: jest.fn().mockImplementation((params) => params),
    DeleteObjectCommand: jest.fn().mockImplementation((params) => params),
  };
});

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              const config: Record<string, string> = {
                S3_BUCKET: 'test-bucket',
                S3_ENDPOINT: 'http://localhost:9000',
                S3_REGION: 'us-east-1',
                S3_ACCESS_KEY_ID: 'minioadmin',
                S3_SECRET_ACCESS_KEY: 'minioadmin',
              };
              return config[key] || defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  describe('upload', () => {
    it('should upload file and return URL', async () => {
      const buffer = Buffer.from('test file content');
      const key = 'logos/test-uuid.png';
      const contentType = 'image/png';

      const url = await service.upload(buffer, key, contentType);

      expect(url).toBe('http://localhost:9000/test-bucket/logos/test-uuid.png');
    });
  });

  describe('delete', () => {
    it('should delete file without error', async () => {
      await expect(service.delete('logos/test.png')).resolves.not.toThrow();
    });
  });

  describe('getUrl', () => {
    it('should return correct URL for key', () => {
      const url = service.getUrl('logos/test.png');
      expect(url).toBe('http://localhost:9000/test-bucket/logos/test.png');
    });
  });
});
