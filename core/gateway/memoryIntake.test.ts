import { defineIntakeContract } from './intakeContract.ts';
import { MemoryIntake } from './memoryIntake.ts';

defineIntakeContract('MemoryIntake', async () => {
  const intake = new MemoryIntake();
  return { intake, count: async () => intake.jobs.length };
});
