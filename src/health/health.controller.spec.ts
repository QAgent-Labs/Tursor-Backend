import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let configGet: jest.Mock;

  beforeEach(async () => {
    configGet = jest.fn().mockReturnValue(9090);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: configGet },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns ok status with configured PORT', () => {
    configGet.mockReturnValue(3000);

    expect(controller.getHealth()).toEqual({ status: 'ok', port: 3000 });
    expect(configGet).toHaveBeenCalledWith('PORT');
  });

  it('falls back to 9090 when PORT is unset', () => {
    configGet.mockReturnValue(undefined);

    expect(controller.getHealth()).toEqual({ status: 'ok', port: 9090 });
  });
});
