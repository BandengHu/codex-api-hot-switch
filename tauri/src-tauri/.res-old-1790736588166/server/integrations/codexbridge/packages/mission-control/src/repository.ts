import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionCheckpoint,
  MissionEnvironmentStamp,
  MissionEvent,
  MissionGeneration,
  PlanChangeRequest,
  WorkItem,
} from './types.js';

export interface MissionRepository {
  getMissionById(id: string): Mission | null;
  listMissions(): Mission[];
  listResumableMissions(now?: number): Mission[];
  saveMission(mission: Mission): Mission;
  resetMission(mission: Mission): Mission;

  getWorkItemById(id: string): WorkItem | null;
  saveWorkItem(workItem: WorkItem): WorkItem;

  getGenerationById(id: string): MissionGeneration | null;
  listGenerations(missionId: string): MissionGeneration[];
  saveGeneration(generation: MissionGeneration): MissionGeneration;

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null;
  listChecklistSnapshots(missionId: string): ChecklistSnapshot[];
  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot;

  getPlanChangeRequestById(id: string): PlanChangeRequest | null;
  listPlanChangeRequests(missionId: string): PlanChangeRequest[];
  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest;

  getAttemptById(id: string): MissionAttempt | null;
  listAttempts(missionId: string): MissionAttempt[];
  saveAttempt(attempt: MissionAttempt): MissionAttempt;

  getEnvironmentStampById(id: string): MissionEnvironmentStamp | null;
  listEnvironmentStamps(missionId: string): MissionEnvironmentStamp[];
  saveEnvironmentStamp(stamp: MissionEnvironmentStamp): MissionEnvironmentStamp;

  getCheckpointById(id: string): MissionCheckpoint | null;
  listCheckpoints(missionId: string): MissionCheckpoint[];
  saveCheckpoint(checkpoint: MissionCheckpoint): MissionCheckpoint;

  listEvents(missionId: string): MissionEvent[];
  appendEvent(event: MissionEvent): MissionEvent;
}
