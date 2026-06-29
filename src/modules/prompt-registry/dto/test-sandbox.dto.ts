import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class TestSandboxDto {
  @IsString()
  @IsNotEmpty()
  version: string; // version to test

  @IsObject()
  context: Record<string, string>; // test variables context
}
