import { IsEmail, IsEnum } from 'class-validator';

export class InviteMemberDto {
  @IsEmail()
  email: string;

  @IsEnum(['admin', 'operator', 'viewer'])
  role: 'admin' | 'operator' | 'viewer';
}
