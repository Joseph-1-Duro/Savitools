import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateWorkspaceDTO } from './dto/create-workspace.dto';
import { RenameWorkspaceDTO } from './dto/rename-workspace.dto';
import { UpdateWorkspaceDTO } from './dto/update-workspace.dto';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceService } from './workspace.service';

@ApiTags('workspaces')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  // ------------------------------------------------------------------------
  //  Named workspace (composer) endpoints
  // ------------------------------------------------------------------------

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List workspaces for the current user' })
  @ApiQuery({ name: 'tool', required: false, enum: ['sandbox', 'inspector', 'webhooks', 'composer'] })
  @ApiResponse({ status: 200, description: 'Workspaces listed' })
  async listWorkspaces(
    @CurrentUser() user: { id: string },
    @Query('tool') tool?: string,
  ) {
    const workspaces = await this.workspaceService.listWorkspaces(user.id, tool);
    return {
      workspaces: workspaces.map((w) => this.toWorkspaceSummary(w)),
    };
  }

  @Post('composer')
  @ApiOperation({ summary: 'Create a named composer workspace' })
  @ApiResponse({ status: 201, description: 'Workspace created' })
  @ApiResponse({ status: 400, description: 'Invalid data or duplicate name' })
  async createComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateWorkspaceDTO,
  ) {
    const workspace = await this.workspaceService.createWorkspace(user.id, dto);
    return this.toWorkspaceResponse(workspace, true);
  }

  @Get('composer/:id')
  @ApiOperation({ summary: 'Get a named composer workspace by ID' })
  @ApiResponse({ status: 200, description: 'Workspace retrieved' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async getComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const workspace = await this.workspaceService.getWorkspaceById(user.id, id);
    return this.toWorkspaceResponse(workspace, true);
  }

  @Put('composer/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update composer workspace data' })
  @ApiResponse({ status: 200, description: 'Workspace updated' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async updateComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateWorkspaceDTO,
  ) {
    const workspace = await this.workspaceService.updateWorkspaceData(user.id, id, dto);
    return this.toWorkspaceResponse(workspace, true);
  }

  @Patch('composer/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename a composer workspace' })
  @ApiResponse({ status: 200, description: 'Workspace renamed' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async renameComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: RenameWorkspaceDTO,
  ) {
    const workspace = await this.workspaceService.renameWorkspace(user.id, id, dto);
    return this.toWorkspaceResponse(workspace);
  }

  @Delete('composer/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a composer workspace' })
  @ApiResponse({ status: 200, description: 'Workspace deleted' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async deleteComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.workspaceService.deleteWorkspace(user.id, id);
    return { success: true };
  }

  @Post('composer/:id/duplicate')
  @ApiOperation({ summary: 'Duplicate a composer workspace' })
  @ApiResponse({ status: 201, description: 'Duplicate created' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async duplicateComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const workspace = await this.workspaceService.duplicateWorkspace(user.id, id);
    return this.toWorkspaceResponse(workspace, true);
  }

  @Get('composer/:id/export')
  @ApiOperation({ summary: 'Export composer workspace as JSON' })
  @ApiResponse({ status: 200, description: 'Exported workspace JSON' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async exportComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.workspaceService.exportWorkspace(user.id, id);
  }

  @Post('composer/import')
  @ApiOperation({ summary: 'Import a composer workspace from JSON' })
  @ApiResponse({ status: 201, description: 'Workspace imported' })
  @ApiResponse({ status: 400, description: 'Invalid workspace data' })
  async importComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateWorkspaceDTO,
  ) {
    const workspace = await this.workspaceService.importWorkspace(user.id, dto);
    return this.toWorkspaceResponse(workspace, true);
  }

  @Post('composer/:id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a read-only share link' })
  @ApiResponse({ status: 200, description: 'Share link generated' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async shareComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.workspaceService.shareWorkspace(user.id, id);
  }

  @Post('composer/:id/unshare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the share link' })
  @ApiResponse({ status: 200, description: 'Share link removed' })
  @ApiResponse({ status: 404, description: 'Workspace not found' })
  async unshareComposerWorkspace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.workspaceService.unshareWorkspace(user.id, id);
    return { success: true };
  }

  // ------------------------------------------------------------------------
  //  Generic tool workspace endpoints
  // ------------------------------------------------------------------------

  @Get(':tool')
  @ApiOperation({ summary: 'Get persisted tool state for the current user' })
  @ApiParam({ name: 'tool', enum: ['sandbox', 'inspector', 'webhooks', 'composer'] })
  @ApiResponse({ status: 200, description: 'Tool workspace retrieved' })
  @ApiResponse({ status: 400, description: 'Invalid tool name' })
  async getWorkspace(
    @CurrentUser() user: { id: string },
    @Param('tool') tool: string,
  ) {
    const workspaceTool = await this.workspaceService.assertTool(tool);
    const data = await this.workspaceService.getWorkspace(user.id, workspaceTool);
    return { tool: workspaceTool, data };
  }

  @Put(':tool')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save tool state for the current user' })
  @ApiParam({ name: 'tool', enum: ['sandbox', 'inspector', 'webhooks', 'composer'] })
  @ApiResponse({ status: 200, description: 'Tool workspace saved' })
  @ApiResponse({ status: 400, description: 'Invalid tool name or data' })
  async upsertWorkspace(
    @CurrentUser() user: { id: string },
    @Param('tool') tool: string,
    @Body() dto: UpdateWorkspaceDTO,
  ) {
    const workspaceTool = await this.workspaceService.assertTool(tool);
    const data = await this.workspaceService.upsertWorkspace(user.id, workspaceTool, dto);
    return { tool: workspaceTool, data };
  }

  // ------------------------------------------------------------------------
  //  Helpers
  // -----------------------------------------------------------------------

  private toWorkspaceSummary(workspace: Workspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      tool: workspace.tool,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  private toWorkspaceResponse(workspace: Workspace, includeData = false) {
    return {
      ...this.toWorkspaceSummary(workspace),
      ...(includeData ? { data: workspace.data } : {}),
    };
  }
}
