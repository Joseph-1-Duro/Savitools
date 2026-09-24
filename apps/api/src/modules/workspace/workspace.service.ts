import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { CreateWorkspaceDTO } from './dto/create-workspace.dto';
import { RenameWorkspaceDTO } from './dto/rename-workspace.dto';
import { UpdateWorkspaceDTO } from './dto/update-workspace.dto';
import { ComposerStateSchema } from './composer-state.schema';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceTool } from './workspace-tool.enum';

@Injectable()
export class WorkspaceService {
  constructor(
    @InjectRepository(Workspace)
    private readonly workspacesRepository: Repository<Workspace>,
  ) {}

  // -------------------------------------------------------------------------
  //  Existing generic workspace methods
  // -------------------------------------------------------------------------

  async getWorkspace(userId: string, tool: WorkspaceTool): Promise<Record<string, unknown>> {
    const workspace = await this.workspacesRepository.findOne({
      where: { userId, tool, name: IsNull() },
    });

    return workspace?.data ?? {};
  }

  async upsertWorkspace(
    userId: string,
    tool: WorkspaceTool,
    dto: UpdateWorkspaceDTO,
  ): Promise<Record<string, unknown>> {
    let workspace = await this.workspacesRepository.findOne({
      where: { userId, tool, name: IsNull() },
    });

    if (workspace) {
      workspace.data = dto.data;
    } else {
      workspace = this.workspacesRepository.create({
        userId,
        tool,
        data: dto.data,
        name: null,
      });
    }

    const saved = await this.workspacesRepository.save(workspace);
    return saved.data;
  }

  async assertTool(tool: string): Promise<WorkspaceTool> {
    if (!Object.values(WorkspaceTool).includes(tool as WorkspaceTool)) {
      throw new NotFoundException(`Unknown workspace tool: ${tool}`);
    }

    return tool as WorkspaceTool;
  }

  // -------------------------------------------------------------------------
  //  Named composer workspace methods
  // ------------------------------------------------------------------------

  async listWorkspaces(userId: string, tool?: string): Promise<Workspace[]> {
    const where: Record<string, unknown> = { userId };
    if (tool) {
      const workspaceTool = await this.assertTool(tool);
      where.tool = workspaceTool;
    }

    return this.workspacesRepository.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  async createWorkspace(userId: string, dto: CreateWorkspaceDTO): Promise<Workspace> {
    const tool = WorkspaceTool.COMPOSER;
    const name = dto.name.trim();

    await this.assertWorkspaceNameAvailable(userId, tool, name);

    const workspace = this.workspacesRepository.create({
      userId,
      tool,
      name,
      data: dto.data,
    });

    return this.workspacesRepository.save(workspace);
  }

  async getWorkspaceById(userId: string, id: string): Promise<Workspace> {
    return this.findWorkspaceForUser(userId, id);
  }

  async updateWorkspaceData(userId: string, id: string, dto: UpdateWorkspaceDTO): Promise<Workspace> {
    const workspace = await this.findWorkspaceForUser(userId, id);
    workspace.data = dto.data;
    return this.workspacesRepository.save(workspace);
  }

  async renameWorkspace(userId: string, id: string, dto: RenameWorkspaceDTO): Promise<Workspace> {
    const workspace = await this.findWorkspaceForUser(userId, id);
    const newName = dto.name.trim();

    if (workspace.name === newName) {
      return workspace;
    }

    await this.assertWorkspaceNameAvailable(userId, workspace.tool, newName, id);
    workspace.name = newName;

    return this.workspacesRepository.save(workspace);
  }

  async deleteWorkspace(userId: string, id: string): Promise<void> {
    const workspace = await this.findWorkspaceForUser(userId, id);
    await this.workspacesRepository.remove(workspace);
  }

  async duplicateWorkspace(userId: string, id: string): Promise<Workspace> {
    const source = await this.findWorkspaceForUser(userId, id);
    const copyName = `${source.name ?? 'Untitled'} (copy)`;
    const data = JSON.parse(JSON.stringify(source.data)) as Record<string, unknown>;

    return this.createWorkspace(userId, { name: copyName, data });
  }

  async exportWorkspace(userId: string, id: string) {
    const workspace = await this.findWorkspaceForUser(userId, id);

    return {
      id: workspace.id,
      name: workspace.name,
      tool: workspace.tool,
      data: workspace.data,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  async importWorkspace(userId: string, input: CreateWorkspaceDTO): Promise<Workspace> {
    const validationError = ComposerStateSchema.validate(input.data);
    if (validationError) {
      throw new BadRequestException(`Invalid composer data: ${validationError}`);
    }

    return this.createWorkspace(userId, input);
  }

  async shareWorkspace(
    userId: string,
    id: string,
    expiresInDays = 7,
  ): Promise<{ token: string; expiresAt: Date; url: string }> {
    const workspace = await this.findWorkspaceForUser(userId, id);

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    workspace.shareToken = token;
    workspace.shareExpiresAt = expiresAt;

    await this.workspacesRepository.save(workspace);

    return {
      token,
      expiresAt,
      url: `/shared/composer/${token}`,
    };
  }

  async unshareWorkspace(userId: string, id: string): Promise<Workspace> {
    const workspace = await this.findWorkspaceForUser(userId, id);

    workspace.shareToken = null;
    workspace.shareExpiresAt = null;

    return this.workspacesRepository.save(workspace);
  }

  async getSharedWorkspace(token: string): Promise<Workspace> {
    const workspace = await this.workspacesRepository.findOne({
      where: { shareToken: token },
    });

    if (!workspace) {
      throw new NotFoundException('Shared workspace not found');
    }

    if (workspace.shareExpiresAt && workspace.shareExpiresAt < new Date()) {
      throw new NotFoundException('Shared workspace link has expired');
    }

    return workspace;
  }

  // -------------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------------

  private async findWorkspaceForUser(userId: string, id: string): Promise<Workspace> {
    const workspace = await this.workspacesRepository.findOne({
      where: { id, userId },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  private async assertWorkspaceNameAvailable(
    userId: string,
    tool: WorkspaceTool,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.workspacesRepository.findOne({
      where: { userId, tool, name },
    });

    if (existing && existing.id !== excludeId) {
      throw new BadRequestException(`A workspace named "${name}" already exists`);
    }
  }
}
