import { planRepository } from './plans/repository.js';

console.info(`Simulated catalogue is ready with ${planRepository.listCatalogue().length} offerings.`);
planRepository.close();
