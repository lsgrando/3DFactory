import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { InventoryItem } from './entities/inventory-item.entity';
import { Lot } from './entities/lot.entity';
import { Movement, MovementType } from './entities/movement.entity';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem)
    private inventoryItemRepository: Repository<InventoryItem>,
    @InjectRepository(Lot)
    private lotRepository: Repository<Lot>,
    @InjectRepository(Movement)
    private movementRepository: Repository<Movement>,
    private dataSource: DataSource,
  ) {}

  findAll() {
    return this.inventoryItemRepository.find({ relations: ['lots'] });
  }

  findOne(id: number) {
    return this.inventoryItemRepository.findOne({
      where: { id },
      relations: ['lots', 'lots.movements'],
    });
  }

  async createItem(itemData: Partial<InventoryItem>) {
    const item = this.inventoryItemRepository.create(itemData);
    return this.inventoryItemRepository.save(item);
  }

  async addLot(itemId: number, lotData: Partial<Lot>) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const item = await queryRunner.manager.findOne(InventoryItem, {
        where: { id: itemId },
        relations: ['lots'],
      });

      if (!item) {
        throw new Error('Item not found');
      }

      const lot = queryRunner.manager.create(Lot, {
        ...lotData,
        inventoryItem: item,
        remainingQuantity: lotData.initialQuantity,
      });
      const savedLot = await queryRunner.manager.save(lot);

      const movement = queryRunner.manager.create(Movement, {
        type: MovementType.ENTRY,
        quantity: lot.initialQuantity,
        lot: savedLot,
        reason: 'Initial lot entry',
      });
      await queryRunner.manager.save(movement);

      // Recalculate average cost and total quantity
      const allLots = await queryRunner.manager.find(Lot, {
        where: { inventoryItem: { id: itemId } },
      });

      let totalValue = 0;
      let totalQty = 0;

      allLots.forEach((l) => {
        const qty = Number(l.remainingQuantity);
        totalQty += qty;
        totalValue += qty * Number(l.costPrice);
      });

      item.totalQuantity = totalQty;
      item.averageCost = totalQty > 0 ? totalValue / totalQty : 0;

      await queryRunner.manager.save(item);

      await queryRunner.commitTransaction();
      return savedLot;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
