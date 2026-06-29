import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { InvitationService } from './services/invitation.service';
import { MockEmailService } from './services/email.service';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { EmailVerificationToken } from './entities/email-verification-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { Invitation } from './entities/invitation.entity';
import { EMAIL_SERVICE } from './interfaces/email-service.interface';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      RefreshToken,
      EmailVerificationToken,
      PasswordResetToken,
      Invitation,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'dev-secret-change-in-production'),
        signOptions: {
          expiresIn: configService.get<number>('JWT_ACCESS_TTL_SECONDS', 900), // 15 min
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    InvitationService,
    {
      provide: EMAIL_SERVICE,
      useClass: MockEmailService,
    },
  ],
  exports: [AuthService, InvitationService, JwtModule],
})
export class AuthModule {}
