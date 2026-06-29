import { Test, TestingModule } from '@nestjs/testing';
import { PermissionsService, Role, Resource, Action } from './permissions.service';

describe('PermissionsService', () => {
  let service: PermissionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PermissionsService],
    }).compile();

    service = module.get<PermissionsService>(PermissionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Admin role - full access', () => {
    const allResources: Resource[] = [
      'clinics', 'brands', 'agents', 'content', 'campaigns',
      'calendar', 'members', 'settings', 'knowledge-hub',
      'guardrails', 'observability', 'privacy',
    ];
    const allActions: Action[] = ['create', 'read', 'update', 'delete', 'manage'];

    it('should allow admin full access to all resources', () => {
      for (const resource of allResources) {
        for (const action of allActions) {
          expect(service.canAccess('admin', resource, action)).toBe(true);
        }
      }
    });
  });

  describe('Operator role - content, campaigns, calendar', () => {
    it('should allow operator to create, read, update content', () => {
      expect(service.canAccess('operator', 'content', 'create')).toBe(true);
      expect(service.canAccess('operator', 'content', 'read')).toBe(true);
      expect(service.canAccess('operator', 'content', 'update')).toBe(true);
    });

    it('should deny operator delete and manage on content', () => {
      expect(service.canAccess('operator', 'content', 'delete')).toBe(false);
      expect(service.canAccess('operator', 'content', 'manage')).toBe(false);
    });

    it('should allow operator to read and create campaigns', () => {
      expect(service.canAccess('operator', 'campaigns', 'read')).toBe(true);
      expect(service.canAccess('operator', 'campaigns', 'create')).toBe(true);
    });

    it('should deny operator update, delete, manage on campaigns', () => {
      expect(service.canAccess('operator', 'campaigns', 'update')).toBe(false);
      expect(service.canAccess('operator', 'campaigns', 'delete')).toBe(false);
      expect(service.canAccess('operator', 'campaigns', 'manage')).toBe(false);
    });

    it('should allow operator to read, create, update calendar', () => {
      expect(service.canAccess('operator', 'calendar', 'read')).toBe(true);
      expect(service.canAccess('operator', 'calendar', 'create')).toBe(true);
      expect(service.canAccess('operator', 'calendar', 'update')).toBe(true);
    });

    it('should deny operator delete and manage on calendar', () => {
      expect(service.canAccess('operator', 'calendar', 'delete')).toBe(false);
      expect(service.canAccess('operator', 'calendar', 'manage')).toBe(false);
    });

    it('should deny operator access to resources not in their matrix', () => {
      const deniedResources: Resource[] = [
        'clinics', 'brands', 'agents', 'members', 'settings',
        'knowledge-hub', 'guardrails', 'observability', 'privacy',
      ];
      for (const resource of deniedResources) {
        expect(service.canAccess('operator', resource, 'read')).toBe(false);
        expect(service.canAccess('operator', resource, 'create')).toBe(false);
      }
    });
  });

  describe('Viewer role - read-only access', () => {
    const allResources: Resource[] = [
      'clinics', 'brands', 'agents', 'content', 'campaigns',
      'calendar', 'members', 'settings', 'knowledge-hub',
      'guardrails', 'observability', 'privacy',
    ];

    it('should allow viewer to read all resources', () => {
      for (const resource of allResources) {
        expect(service.canAccess('viewer', resource, 'read')).toBe(true);
      }
    });

    it('should deny viewer any write action on all resources', () => {
      const writeActions: Action[] = ['create', 'update', 'delete', 'manage'];
      for (const resource of allResources) {
        for (const action of writeActions) {
          expect(service.canAccess('viewer', resource, action)).toBe(false);
        }
      }
    });
  });

  describe('Edge cases', () => {
    it('should deny access for unknown role', () => {
      expect(service.canAccess('unknown' as Role, 'content', 'read')).toBe(false);
    });

    it('should deny access for unknown resource', () => {
      expect(service.canAccess('admin', 'unknown-resource', 'read')).toBe(false);
    });

    it('should deny access for unknown action', () => {
      expect(service.canAccess('admin', 'content', 'unknown-action')).toBe(false);
    });
  });

  describe('getAllowedActions', () => {
    it('should return all actions for admin on any resource', () => {
      const actions = service.getAllowedActions('admin', 'content');
      expect(actions).toEqual(['create', 'read', 'update', 'delete', 'manage']);
    });

    it('should return limited actions for operator on content', () => {
      const actions = service.getAllowedActions('operator', 'content');
      expect(actions).toEqual(['create', 'read', 'update']);
    });

    it('should return only read for viewer on any resource', () => {
      const actions = service.getAllowedActions('viewer', 'settings');
      expect(actions).toEqual(['read']);
    });

    it('should return empty array for operator on unauthorized resource', () => {
      const actions = service.getAllowedActions('operator', 'settings');
      expect(actions).toEqual([]);
    });

    it('should return empty array for unknown role', () => {
      const actions = service.getAllowedActions('unknown' as Role, 'content');
      expect(actions).toEqual([]);
    });
  });

  describe('getPermissionsForRole', () => {
    it('should return full permission map for admin', () => {
      const permissions = service.getPermissionsForRole('admin');
      expect(Object.keys(permissions)).toHaveLength(12);
      expect(permissions['content']).toContain('manage');
    });

    it('should return limited permission map for operator', () => {
      const permissions = service.getPermissionsForRole('operator');
      expect(Object.keys(permissions)).toHaveLength(3);
      expect(permissions['content']).toBeDefined();
      expect(permissions['campaigns']).toBeDefined();
      expect(permissions['calendar']).toBeDefined();
    });

    it('should return read-only permission map for viewer', () => {
      const permissions = service.getPermissionsForRole('viewer');
      expect(Object.keys(permissions)).toHaveLength(12);
      for (const actions of Object.values(permissions)) {
        expect(actions).toEqual(['read']);
      }
    });

    it('should return empty object for unknown role', () => {
      const permissions = service.getPermissionsForRole('unknown' as Role);
      expect(permissions).toEqual({});
    });
  });
});
