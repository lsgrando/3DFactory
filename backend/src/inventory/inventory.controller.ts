import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryItem } from './entities/inventory-item.entity';
import { Lot } from './entities/lot.entity';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  findAll() {
    return this.inventoryService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.inventoryService.findOne(+id);
  }

  @Post()
  createItem(@Body() itemData: Partial<InventoryItem>) {
    return this.inventoryService.createItem(itemData);
  }

  @Post(':id/lots')
  addLot(@Param('id') id: string, @Body() lotData: Partial<Lot>) {
    return this.inventoryService.addLot(+id, lotData);
  }
}
