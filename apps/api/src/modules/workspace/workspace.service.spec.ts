import { WorkspaceService } from './workspace.service';
import { NotFoundException } from '@nestjs/common';
import { WorkspaceTool } from './workspace-tool.enum';

function mockRepo() {
  return {
    findOne: jest.fn(),
    create: jest.fn((dto) => ({ id: 'ws-1', ...dto })),
    save: jest.fn(async (entity) => entity),
  };
}

describe('WorkspaceService', () => {
  let service: WorkspaceService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(() => {
    repo = mockRepo();
    service = new WorkspaceService(repo as any);
  });

  describe('getWorkspace', () => {
    it('returns workspace data when found', async () => {
      repo.findOne.mockResolvedValue({
        userId: 'user-1',
        tool: WorkspaceTool.SANDBOX,
        data: { key: 'value' },
      });

      const result = await service.getWorkspace('user-1', WorkspaceTool.SANDBOX);
      expect(result).toEqual({ key: 'value' });
    });

    it('returns empty object when not found', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.getWorkspace('user-1', WorkspaceTool.INSPECTOR);
      expect(result).toEqual({});
    });
  });

  describe('upsertWorkspace', () => {
    it('creates a new workspace when none exists', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.upsertWorkspace('user-1', WorkspaceTool.COMPOSER, {
        data: { layout: 'grid' },
      });

      expect(repo.create).toHaveBeenCalledWith({
        userId: 'user-1',
        tool: WorkspaceTool.COMPOSER,
        data: { layout: 'grid' },
        name: null,
      });
      expect(repo.save).toHaveBeenCalled();
      expect(result).toEqual({ layout: 'grid' });
    });

    it('updates an existing workspace', async () => {
      const existing = {
        id: 'ws-1',
        userId: 'user-1',
        tool: WorkspaceTool.COMPOSER,
        data: { layout: 'list' },
      };
      repo.findOne.mockResolvedValue(existing);

      const result = await service.upsertWorkspace('user-1', WorkspaceTool.COMPOSER, {
        data: { layout: 'grid' },
      });

      expect(existing.data).toEqual({ layout: 'grid' });
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(result).toEqual({ layout: 'grid' });
    });
  });

  describe('assertTool', () => {
    it('returns valid tool names', async () => {
      expect(await service.assertTool('sandbox')).toBe(WorkspaceTool.SANDBOX);
      expect(await service.assertTool('inspector')).toBe(WorkspaceTool.INSPECTOR);
      expect(await service.assertTool('webhooks')).toBe(WorkspaceTool.WEBHOOKS);
      expect(await service.assertTool('composer')).toBe(WorkspaceTool.COMPOSER);
    });

    it('throws NotFoundException for invalid tool names', async () => {
      await expect(service.assertTool('invalid')).rejects.toThrow(NotFoundException);
      await expect(service.assertTool('')).rejects.toThrow(NotFoundException);
    });
  });
});
