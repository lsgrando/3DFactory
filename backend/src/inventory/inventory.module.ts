import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryItem } from './entities/inventory-item.entity';
import { Lot } from './entities/lot.entity';
import { Movement } from './entities/movement.entity';

@Module({
  imports: [TypeOrmModule.forFeature([InventoryItem, Lot, Movement])],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
