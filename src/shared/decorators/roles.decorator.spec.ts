import { ROLES_KEY, Roles } from './roles.decorator';

describe('Roles Decorator', () => {
  it('should set metadata with a single role', () => {
    @Roles('admin')
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual(['admin']);
  });

  it('should set metadata with multiple roles', () => {
    @Roles('admin', 'operator')
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual(['admin', 'operator']);
  });

  it('should set metadata with all three roles', () => {
    @Roles('admin', 'operator', 'viewer')
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual(['admin', 'operator', 'viewer']);
  });

  it('should work as a method decorator', () => {
    class TestController {
      @Roles('admin')
      someMethod() {}
    }

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController.prototype.someMethod);
    expect(metadata).toEqual(['admin']);
  });

  it('should set empty array when called with no arguments', () => {
    @Roles()
    class TestController {}

    const metadata = Reflect.getMetadata(ROLES_KEY, TestController);
    expect(metadata).toEqual([]);
  });
});
