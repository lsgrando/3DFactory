import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Lot } from './lot.entity';

@Entity('inventory_items')
export class InventoryItem {
  @PrimaryGeneratedColumn()
  id: number;

  @PrimaryGeneratedColumn('uuid')
  uuid: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  averageCost: number;

  @Column({ type: 'decimal', precision: 10, scale: 3, default: 0 })
  totalQuantity: number;

  @Column({ nullable: true })
  unit: string; // e.g., kg, unit

  @OneToMany(() => Lot, (lot) => lot.inventoryItem)
  lots: Lot[];
}
