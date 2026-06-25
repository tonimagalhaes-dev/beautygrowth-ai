import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  username: process.env.DATABASE_USER || 'beautygrowth',
  password: process.env.DATABASE_PASSWORD || 'beautygrowth_dev',
  database: process.env.DATABASE_NAME || 'beautygrowth_dev',
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
  logging: process.env.NODE_ENV === 'development',
});
