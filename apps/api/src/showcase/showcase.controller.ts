import { Controller, Get } from '@nestjs/common';
import { ShowcaseCatalogService } from './showcase-catalog.service';

@Controller('showcase')
export class ShowcaseController {
  constructor(private readonly showcase: ShowcaseCatalogService) {}

  @Get('catalog')
  catalog() {
    return this.showcase.catalog();
  }
}
