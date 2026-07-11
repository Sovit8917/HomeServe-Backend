import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BannersService } from './banners.service';
import { Public } from '../../common/decorators';

@ApiTags('Banners')
@Controller('banners')
export class BannersController {
  constructor(private bannersService: BannersService) {}

  @Public()
  @Get()
  findActive() {
    return this.bannersService.findActive();
  }
}