import { planRepository } from './plans/repository.js';

console.info(`Simulated catalogue is ready with ${(await planRepository.listCatalogue()).length} offerings.`);
await planRepository.close();
