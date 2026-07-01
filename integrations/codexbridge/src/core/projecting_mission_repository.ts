import type { MissionRepository } from '../../packages/mission-control/src/index.js';
import {
  buildAgentJobMissionPatch,
  readMissionRuntimeStateFromRepository,
} from './mission_control_agent_job_projection.js';
import type { AgentJob } from '../types/core.js';
import type { AgentJobRepository } from '../types/repository.js';

export class ProjectingMissionRepository implements MissionRepository {
  constructor(
    private readonly authority: MissionRepository,
    private readonly agentJobs: AgentJobRepository,
  ) {}

  getMissionById(id: string) {
    return this.authority.getMissionById(id);
  }

  listMissions() {
    return this.authority.listMissions();
  }

  listResumableMissions(now = Date.now()) {
    return this.authority.listResumableMissions(now);
  }

  saveMission(mission: Parameters<MissionRepository['saveMission']>[0]) {
    const saved = this.authority.saveMission(mission);
    this.syncProjection(saved.id);
    return saved;
  }

  resetMission(mission: Parameters<MissionRepository['resetMission']>[0]) {
    const saved = this.authority.resetMission(mission);
    this.syncProjection(saved.id);
    return saved;
  }

  getWorkItemById(id: string) {
    return this.authority.getWorkItemById(id);
  }

  saveWorkItem(workItem: Parameters<MissionRepository['saveWorkItem']>[0]) {
    const saved = this.authority.saveWorkItem(workItem);
    const mission = this.authority
      .listMissions()
      .find((entry) => entry.workItemId === saved.id);
    if (mission) {
      this.syncProjection(mission.id);
    }
    return saved;
  }

  getGenerationById(id: string) {
    return this.authority.getGenerationById(id);
  }

  listGenerations(missionId: string) {
    return this.authority.listGenerations(missionId);
  }

  saveGeneration(generation: Parameters<MissionRepository['saveGeneration']>[0]) {
    const saved = this.authority.saveGeneration(generation);
    this.syncProjection(saved.missionId);
    return saved;
  }

  getChecklistSnapshotById(id: string) {
    return this.authority.getChecklistSnapshotById(id);
  }

  listChecklistSnapshots(missionId: string) {
    return this.authority.listChecklistSnapshots(missionId);
  }

  saveChecklistSnapshot(snapshot: Parameters<MissionRepository['saveChecklistSnapshot']>[0]) {
    const saved = this.authority.saveChecklistSnapshot(snapshot);
    this.syncProjection(saved.missionId);
    return saved;
  }

  getPlanChangeRequestById(id: string) {
    return this.authority.getPlanChangeRequestById(id);
  }

  listPlanChangeRequests(missionId: string) {
    return this.authority.listPlanChangeRequests(missionId);
  }

  savePlanChangeRequest(changeRequest: Parameters<MissionRepository['savePlanChangeRequest']>[0]) {
    const saved = this.authority.savePlanChangeRequest(changeRequest);
    this.syncProjection(saved.missionId);
    return saved;
  }

  getAttemptById(id: string) {
    return this.authority.getAttemptById(id);
  }

  listAttempts(missionId: string) {
    return this.authority.listAttempts(missionId);
  }

  saveAttempt(attempt: Parameters<MissionRepository['saveAttempt']>[0]) {
    const saved = this.authority.saveAttempt(attempt);
    this.syncProjection(saved.missionId);
    return saved;
  }

  getEnvironmentStampById(id: string) {
    return this.authority.getEnvironmentStampById(id);
  }

  listEnvironmentStamps(missionId: string) {
    return this.authority.listEnvironmentStamps(missionId);
  }

  saveEnvironmentStamp(stamp: Parameters<MissionRepository['saveEnvironmentStamp']>[0]) {
    const saved = this.authority.saveEnvironmentStamp(stamp);
    this.syncProjection(saved.missionId);
    return saved;
  }

  getCheckpointById(id: string) {
    return this.authority.getCheckpointById(id);
  }

  listCheckpoints(missionId: string) {
    return this.authority.listCheckpoints(missionId);
  }

  saveCheckpoint(checkpoint: Parameters<MissionRepository['saveCheckpoint']>[0]) {
    const saved = this.authority.saveCheckpoint(checkpoint);
    this.syncProjection(saved.missionId);
    return saved;
  }

  listEvents(missionId: string) {
    return this.authority.listEvents(missionId);
  }

  appendEvent(event: Parameters<MissionRepository['appendEvent']>[0]) {
    const saved = this.authority.appendEvent(event);
    this.syncProjection(saved.missionId);
    return saved;
  }

  private syncProjection(missionId: string): void {
    const currentJob = this.agentJobs.getById(missionId);
    if (!currentJob) {
      return;
    }
    const state = readMissionRuntimeStateFromRepository(this.authority, missionId);
    const patch = buildAgentJobMissionPatch(currentJob, state);
    this.agentJobs.save({
      ...cloneValue(currentJob),
      ...cloneValue(patch),
      updatedAt: Math.max(
        currentJob.updatedAt,
        state.mission?.updatedAt ?? currentJob.updatedAt,
      ),
    });
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
