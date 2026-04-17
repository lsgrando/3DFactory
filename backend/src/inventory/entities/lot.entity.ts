import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn } from 'typeorm';
import { InventoryItem } from './inventory-item.entity';
import { Movement } from './movement.entity';

@Entity('lots')
export class Lot {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  lotNumber: string;

  @Column({ type: 'decimal', precision: 10, scale: 3 })
  initialQuantity: number;

  @Column({ type: 'decimal', precision: 10, scale: 3 })
  remainingQuantity: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  costPrice: number;

  @CreateDateColumn()
  receivedDate: Date;

  @Column({ nullable: true })
  supplier: string;

  @ManyToOne(() => InventoryItem, (item) => item.lots)
  inventoryItem: InventoryItem;

  @OneToMany(() => Movement, (movement) => movement.lot)
  movements: Movement[];
}
